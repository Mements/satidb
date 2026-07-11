/**
 * conflict.ts — Native SQLite INSERT ... ON CONFLICT helpers.
 *
 * Keeps normal `insert(row)` eager/synchronous. Advanced conflict upserts use
 * `db.table.upsertOnConflict(row, target, merge)` so validation and
 * transaction rollback semantics remain identical to the original ORM.
 */
import type { DatabaseContext } from "./context";
import type { AugmentedEntity } from "./types";
import { asZodObject } from "./types";
import { transformForStorage, transformFromStorage } from "./schema";

export type ConflictExpr = {
  sql: string;
  params: any[];
};

function quoteIdent(value: string): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function normalizeConflictTarget(target: string | string[]): string[] {
  const columns = Array.isArray(target) ? target : [target];
  if (columns.length === 0)
    throw new Error(
      "upsertOnConflict() requires at least one conflict target column.",
    );
  for (const column of columns) {
    if (!column || typeof column !== "string") {
      throw new Error(
        "upsertOnConflict() conflict target columns must be non-empty strings.",
      );
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

  /** Current persisted value: table.field */
  current<K extends keyof T & string>(field: K): ConflictExpr {
    return makeExpr(`${quoteIdent(this.tableName)}.${quoteIdent(field)}`);
  }

  /** Incoming value from the failed INSERT: excluded.field */
  excluded<K extends keyof T & string>(field: K): ConflictExpr {
    return makeExpr(`excluded.${quoteIdent(field)}`);
  }

  /** Use incoming value when it is non-null, otherwise keep the current table value. */
  excludedIfNotNull<K extends keyof T & string>(field: K): ConflictExpr {
    return makeExpr(
      `COALESCE(excluded.${quoteIdent(field)}, ${quoteIdent(this.tableName)}.${quoteIdent(field)})`,
    );
  }

  /** Use incoming value when it is neither NULL nor '', otherwise keep the current table value. */
  excludedIfNotEmpty<K extends keyof T & string>(field: K): ConflictExpr {
    return makeExpr(
      `COALESCE(NULLIF(excluded.${quoteIdent(field)}, ''), ${quoteIdent(this.tableName)}.${quoteIdent(field)})`,
    );
  }

  /** Keep the first non-null value: current value wins unless it is NULL. */
  keepFirst<K extends keyof T & string>(field: K): ConflictExpr {
    return makeExpr(
      `COALESCE(${quoteIdent(this.tableName)}.${quoteIdent(field)}, excluded.${quoteIdent(field)})`,
    );
  }

  /** Keep the greater numeric value. */
  max<K extends keyof T & string>(field: K, fallback = 0): ConflictExpr {
    if (!Number.isFinite(fallback))
      throw new Error("max() fallback must be a finite number.");
    const col = quoteIdent(field);
    return makeExpr(
      `MAX(COALESCE(${quoteIdent(this.tableName)}.${col}, ${fallback}), ` +
        `COALESCE(excluded.${col}, ${fallback}))`,
    );
  }

  // Backwards-compatible verbose aliases from the first conflict-upsert draft.
  coalesceExcluded<K extends keyof T & string>(field: K): ConflictExpr {
    return this.excludedIfNotNull(field);
  }

  coalesceExcludedNonEmpty<K extends keyof T & string>(field: K): ConflictExpr {
    return this.excludedIfNotEmpty(field);
  }

  coalesceCurrentExcluded<K extends keyof T & string>(field: K): ConflictExpr {
    return this.keepFirst(field);
  }

  keepExistingIfExcludedEmpty<K extends keyof T & string>(
    field: K,
  ): ConflictExpr {
    return this.excludedIfNotEmpty(field);
  }

  maxCurrentExcluded<K extends keyof T & string>(
    field: K,
    fallback = 0,
  ): ConflictExpr {
    return this.max(field, fallback);
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

export function upsertOnConflict<T extends Record<string, any>>(
  ctx: DatabaseContext,
  entityName: string,
  data: Record<string, any>,
  target: string | string[],
  mapper: (
    helpers: ConflictMergeHelpers<T>,
  ) => Partial<Record<keyof T & string, ConflictExpr>>,
): AugmentedEntity<any> {
  const conflictTarget = normalizeConflictTarget(target);
  const transformed = prepareInsertData(ctx, entityName, data);
  const columns = Object.keys(transformed);
  if (columns.length === 0)
    throw new Error(
      "upsertOnConflict().merge requires at least one insert column.",
    );

  for (const column of conflictTarget) {
    if (!(column in transformed)) {
      throw new Error(
        `upsertOnConflict(${JSON.stringify(column)}) requires the inserted row to include that column.`,
      );
    }
  }

  const helpers = new ConflictMergeHelpers<T>(entityName);
  const mergeMap = mapper(helpers) ?? {};
  const assignments: string[] = [];
  const assignmentParams: any[] = [];

  for (const [column, expr] of Object.entries(mergeMap)) {
    if (!expr || typeof expr.sql !== "string" || !Array.isArray(expr.params)) {
      throw new Error(`Invalid merge expression for column "${column}".`);
    }
    assignments.push(`${quoteIdent(column)} = ${expr.sql}`);
    assignmentParams.push(...expr.params);
  }

  if (assignments.length === 0) {
    throw new Error(
      "upsertOnConflict() requires at least one merge column assignment.",
    );
  }

  const insertParams = columns.map((col) => transformed[col]);
  const sql =
    `INSERT INTO ${quoteIdent(entityName)} (${columns.map(quoteIdent).join(", ")}) ` +
    `VALUES (${columns.map(() => "?").join(", ")}) ` +
    `ON CONFLICT (${conflictTarget.map(quoteIdent).join(", ")}) DO UPDATE SET ${assignments.join(", ")}`;

  ctx._m(`SQL: INSERT ${entityName} ON CONFLICT`, () => {
    ctx._stmt(sql).run(...insertParams, ...assignmentParams);
  });

  const entity = fetchByConflictTarget(
    ctx,
    entityName,
    conflictTarget,
    transformed,
  );
  if (!entity)
    throw new Error("Failed to retrieve entity after conflict upsert");
  return entity;
}

export function insertOnConflictDoNothing<T extends Record<string, any>>(
  ctx: DatabaseContext,
  entityName: string,
  data: Record<string, any>,
  target: string | string[],
): AugmentedEntity<any> | null {
  const conflictTarget = normalizeConflictTarget(target);
  const transformed = prepareInsertData(ctx, entityName, data);
  const columns = Object.keys(transformed);
  if (columns.length === 0)
    throw new Error(
      "insertOnConflictDoNothing() requires at least one insert column.",
    );

  for (const column of conflictTarget) {
    if (!(column in transformed)) {
      throw new Error(
        `insertOnConflictDoNothing(${JSON.stringify(column)}) requires the inserted row to include that column.`,
      );
    }
  }

  const sql =
    `INSERT INTO ${quoteIdent(entityName)} (${columns.map(quoteIdent).join(", ")}) ` +
    `VALUES (${columns.map(() => "?").join(", ")}) ` +
    `ON CONFLICT (${conflictTarget.map(quoteIdent).join(", ")}) DO NOTHING`;

  ctx._m(`SQL: INSERT ${entityName} ON CONFLICT DO NOTHING`, () => {
    ctx._stmt(sql).run(...columns.map((col) => transformed[col]));
  });

  return fetchByConflictTarget(ctx, entityName, conflictTarget, transformed);
}
