/**
 * conflict.ts — Native SQLite INSERT ... ON CONFLICT helpers.
 *
 * Provides the chainable `db.table.insert(row).onConflict(...).merge(...)`
 * API without exposing raw SQL for common merge policies.
 */
import type { DatabaseContext } from "./context";
import type { AugmentedEntity } from "./types";
import { asZodObject } from "./types";
import { transformForStorage, transformFromStorage } from "./schema";

export type ConflictExpr = {
  sql: string;
  params: any[];
};

export type PendingInsertOperation = {
  execute(): AugmentedEntity<any>;
  cancel(): void;
  isPending(): boolean;
};

function quoteIdent(value: string): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function normalizeConflictTarget(target: string | string[]): string[] {
  const columns = Array.isArray(target) ? target : [target];
  if (columns.length === 0)
    throw new Error("onConflict() requires at least one column.");
  for (const column of columns) {
    if (!column || typeof column !== "string") {
      throw new Error("onConflict() columns must be non-empty strings.");
    }
  }
  return columns;
}

function makeExpr(sql: string, params: any[] = []): ConflictExpr {
  return { sql, params };
}

export class ConflictMergeHelpers<
  T extends Record<string, any> = Record<string, any>,
> {
  constructor(private readonly tableName: string) {}

  current<K extends keyof T & string>(field: K): ConflictExpr {
    return makeExpr(`${quoteIdent(this.tableName)}.${quoteIdent(field)}`);
  }

  excluded<K extends keyof T & string>(field: K): ConflictExpr {
    return makeExpr(`excluded.${quoteIdent(field)}`);
  }

  /** Use excluded.field when it is non-null, otherwise keep the current table value. */
  coalesceExcluded<K extends keyof T & string>(field: K): ConflictExpr {
    return makeExpr(
      `COALESCE(excluded.${quoteIdent(field)}, ${quoteIdent(this.tableName)}.${quoteIdent(field)})`,
    );
  }

  /** Use excluded.field when it is neither NULL nor '', otherwise keep the current table value. */
  coalesceExcludedNonEmpty<K extends keyof T & string>(field: K): ConflictExpr {
    return makeExpr(
      `COALESCE(NULLIF(excluded.${quoteIdent(field)}, ''), ${quoteIdent(this.tableName)}.${quoteIdent(field)})`,
    );
  }

  /** Keep the current value once it exists; otherwise use excluded.field. */
  coalesceCurrentExcluded<K extends keyof T & string>(field: K): ConflictExpr {
    return makeExpr(
      `COALESCE(${quoteIdent(this.tableName)}.${quoteIdent(field)}, excluded.${quoteIdent(field)})`,
    );
  }

  /**
   * CASE WHEN excluded.field IS NOT NULL AND excluded.field != '' THEN excluded.field
   * ELSE current.field END
   */
  keepExistingIfExcludedEmpty<K extends keyof T & string>(
    field: K,
  ): ConflictExpr {
    const col = quoteIdent(field);
    return makeExpr(
      `CASE WHEN excluded.${col} IS NOT NULL AND excluded.${col} != '' ` +
        `THEN excluded.${col} ELSE ${quoteIdent(this.tableName)}.${col} END`,
    );
  }

  /** MAX(COALESCE(current.field, fallback), COALESCE(excluded.field, fallback)) */
  maxCurrentExcluded<K extends keyof T & string>(
    field: K,
    fallback = 0,
  ): ConflictExpr {
    if (!Number.isFinite(fallback))
      throw new Error("maxCurrentExcluded() fallback must be a finite number.");
    const col = quoteIdent(field);
    return makeExpr(
      `MAX(COALESCE(${quoteIdent(this.tableName)}.${col}, ${fallback}), ` +
        `COALESCE(excluded.${col}, ${fallback}))`,
    );
  }

  /** Set a column to a parameterized literal value. */
  literal(value: any): ConflictExpr {
    return makeExpr("?", [value]);
  }

  /** Escape hatch for uncommon expressions while still collecting params safely. */
  sql(fragment: string, params: any[] = []): ConflictExpr {
    if (!fragment || typeof fragment !== "string")
      throw new Error("sql() requires a SQL fragment.");
    return makeExpr(fragment, params);
  }
}

export class OnConflictBuilder<
  T extends Record<string, any> = Record<string, any>,
> {
  constructor(
    private readonly ctx: DatabaseContext,
    private readonly entityName: string,
    private readonly data: Record<string, any>,
    private readonly target: string[],
  ) {}

  merge(
    mapper: (
      helpers: ConflictMergeHelpers<T>,
    ) => Partial<Record<keyof T & string, ConflictExpr>>,
  ): AugmentedEntity<any> {
    return nativeConflictMerge(
      this.ctx,
      this.entityName,
      this.data,
      this.target,
      mapper as any,
    );
  }

  doNothing(): AugmentedEntity<any> | null {
    return nativeConflictDoNothing(
      this.ctx,
      this.entityName,
      this.data,
      this.target,
    );
  }
}

export function createLazyInsertResult(
  ctx: DatabaseContext,
  entityName: string,
  data: Record<string, any>,
  executeStandardInsert: () => AugmentedEntity<any>,
): AugmentedEntity<any> {
  let executed = false;
  let cancelled = false;
  let entity: AugmentedEntity<any> | null = null;

  const pending: PendingInsertOperation = {
    execute: () => {
      if (cancelled) {
        throw new Error(
          `Insert into "${entityName}" was converted to an onConflict() operation.`,
        );
      }
      if (!executed) {
        executed = true;
        ctx._unregisterPendingInsert?.(pending);
        entity = executeStandardInsert();
      }
      return entity!;
    },
    cancel: () => {
      cancelled = true;
      ctx._unregisterPendingInsert?.(pending);
    },
    isPending: () => !executed && !cancelled,
  };

  ctx._registerPendingInsert?.(pending);

  // Preserve the old side-effect semantics for fire-and-forget inserts:
  // if the caller does not access properties and does not chain onConflict(),
  // execute the insert at the end of the current turn. Any subsequent ORM
  // operation also flushes this queue synchronously before it runs.
  queueMicrotask(() => {
    if (pending.isPending()) pending.execute();
  });

  const materialize = () => pending.execute();

  return new Proxy({} as any, {
    get(_target, prop, receiver) {
      if (prop === "onConflict") {
        pending.cancel();
        return (target: string | string[]) =>
          new OnConflictBuilder(
            ctx,
            entityName,
            data,
            normalizeConflictTarget(target),
          );
      }
      if (prop === Symbol.toStringTag) return "InsertResult";
      if (prop === "then") return undefined;
      const value = Reflect.get(materialize(), prop, receiver);
      return typeof value === "function" ? value.bind(entity) : value;
    },
    set(_target, prop, value, receiver) {
      return Reflect.set(materialize(), prop, value, receiver);
    },
    has(_target, prop) {
      if (prop === "onConflict") return true;
      return prop in materialize();
    },
    ownKeys() {
      return Reflect.ownKeys(materialize());
    },
    getOwnPropertyDescriptor(_target, prop) {
      return Object.getOwnPropertyDescriptor(materialize(), prop);
    },
  }) as AugmentedEntity<any>;
}

function prepareInsertData(
  ctx: DatabaseContext,
  entityName: string,
  data: Record<string, any>,
): Record<string, any> {
  const schema = ctx.schemas[entityName]!;
  let inputData = { ...data } as Record<string, any>;

  const hooks = ctx.hooks[entityName];
  if (hooks?.beforeInsert) {
    const result = hooks.beforeInsert(inputData);
    if (result) inputData = result;
  }

  const validatedData = asZodObject(schema).passthrough().parse(inputData);
  const transformed = transformForStorage(validatedData);

  if (ctx.timestamps) {
    const now = new Date().toISOString();
    if (transformed.createdAt === undefined) transformed.createdAt = now;
    transformed.updatedAt = now;
  }

  return transformed;
}

function fetchByConflictTarget(
  ctx: DatabaseContext,
  entityName: string,
  target: string[],
  transformed: Record<string, any>,
): AugmentedEntity<any> | null {
  const where = target.map((col) => `${quoteIdent(col)} = ?`).join(" AND ");
  const values = target.map((col) => transformed[col]);
  if (values.some((value) => value === undefined)) {
    throw new Error(
      `Cannot fetch upserted "${entityName}" row: conflict target value missing.`,
    );
  }
  const row = ctx
    ._stmt(`SELECT * FROM ${quoteIdent(entityName)} WHERE ${where} LIMIT 1`)
    .get(...values) as any;
  if (!row) return null;
  return ctx.attachMethods(
    entityName,
    transformFromStorage(row, ctx.schemas[entityName]!),
  );
}

function nativeConflictMerge(
  ctx: DatabaseContext,
  entityName: string,
  data: Record<string, any>,
  target: string[],
  mapper: (helpers: ConflictMergeHelpers<any>) => Record<string, ConflictExpr>,
): AugmentedEntity<any> {
  const transformed = prepareInsertData(ctx, entityName, data);
  const columns = Object.keys(transformed);
  if (columns.length === 0)
    throw new Error(
      "onConflict().merge() requires at least one insert column.",
    );

  for (const column of target) {
    if (!(column in transformed)) {
      throw new Error(
        `onConflict(${JSON.stringify(column)}) requires the inserted row to include that column.`,
      );
    }
  }

  const helpers = new ConflictMergeHelpers(entityName);
  const mergeMap = mapper(helpers) ?? {};
  const assignments: string[] = [];
  const params: any[] = [];

  for (const [column, expr] of Object.entries(mergeMap)) {
    if (!expr || typeof expr.sql !== "string" || !Array.isArray(expr.params)) {
      throw new Error(`Invalid merge expression for column "${column}".`);
    }
    assignments.push(`${quoteIdent(column)} = ${expr.sql}`);
    params.push(...expr.params);
  }

  if (assignments.length === 0) {
    throw new Error(
      "onConflict().merge() requires at least one column assignment.",
    );
  }

  const insertParams = columns.map((col) => transformed[col]);
  const sql =
    `INSERT INTO ${quoteIdent(entityName)} (${columns.map(quoteIdent).join(", ")}) ` +
    `VALUES (${columns.map(() => "?").join(", ")}) ` +
    `ON CONFLICT (${target.map(quoteIdent).join(", ")}) DO UPDATE SET ${assignments.join(", ")}`;

  ctx._m(`SQL: INSERT ${entityName} ON CONFLICT`, () => {
    ctx._stmt(sql).run(...insertParams, ...params);
  });

  const entity = fetchByConflictTarget(ctx, entityName, target, transformed);
  if (!entity)
    throw new Error("Failed to retrieve entity after conflict upsert");
  return entity;
}

function nativeConflictDoNothing(
  ctx: DatabaseContext,
  entityName: string,
  data: Record<string, any>,
  target: string[],
): AugmentedEntity<any> | null {
  const transformed = prepareInsertData(ctx, entityName, data);
  const columns = Object.keys(transformed);
  if (columns.length === 0)
    throw new Error(
      "onConflict().doNothing() requires at least one insert column.",
    );

  for (const column of target) {
    if (!(column in transformed)) {
      throw new Error(
        `onConflict(${JSON.stringify(column)}) requires the inserted row to include that column.`,
      );
    }
  }

  const sql =
    `INSERT INTO ${quoteIdent(entityName)} (${columns.map(quoteIdent).join(", ")}) ` +
    `VALUES (${columns.map(() => "?").join(", ")}) ` +
    `ON CONFLICT (${target.map(quoteIdent).join(", ")}) DO NOTHING`;

  ctx._m(`SQL: INSERT ${entityName} ON CONFLICT DO NOTHING`, () => {
    ctx._stmt(sql).run(...columns.map((col) => transformed[col]));
  });

  return fetchByConflictTarget(ctx, entityName, target, transformed);
}
