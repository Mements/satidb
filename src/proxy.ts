/**
 * proxy.ts — Proxy Query System
 *
 * Enables `db.query(c => { ... })` for SQL-like multi-table queries
 * using destructured proxied table references.
 */

import type { z } from "zod";

// =============================================================================
// ColumnNode
// =============================================================================

/**
 * Represents a reference to a specific table column with an alias.
 * Used as a building block for SQL query construction.
 */
export class ColumnNode {
  readonly _type = "COL" as const;
  constructor(
    readonly table: string,
    readonly column: string,
    readonly alias: string,
  ) {}

  /** Quoted alias.column for use as computed property key */
  toString(): string {
    return `"${this.alias}"."${this.column}"`;
  }

  [Symbol.toPrimitive](): string {
    return this.toString();
  }
}

// ---------- SQL Quoting Helpers ----------

function q(name: string): string {
  return `"${name}"`;
}

function qRef(alias: string, column: string): string {
  return `"${alias}"."${column}"`;
}

// ---------- Table Proxy ----------

function createTableProxy(
  tableName: string,
  alias: string,
  columns: Set<string>,
): Record<string, ColumnNode> {
  return new Proxy({} as Record<string, ColumnNode>, {
    get(_target, prop: string): ColumnNode | undefined {
      if (
        prop === (Symbol.toPrimitive as any) ||
        prop === "toString" ||
        prop === "valueOf"
      ) {
        return undefined;
      }
      return new ColumnNode(tableName, prop, alias);
    },
    ownKeys() {
      return [...columns];
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (columns.has(prop as string)) {
        return {
          configurable: true,
          enumerable: true,
          value: new ColumnNode(tableName, prop as string, alias),
        };
      }
      return undefined;
    },
  });
}

// ---------- Context Proxy ----------

interface AliasEntry {
  tableName: string;
  alias: string;
  proxy: Record<string, ColumnNode>;
}

export function createContextProxy(schemas: Record<string, z.ZodType<any>>): {
  proxy: Record<string, Record<string, ColumnNode>>;
  aliasMap: Map<string, AliasEntry[]>;
} {
  const aliases = new Map<string, AliasEntry[]>();
  let aliasCounter = 0;

  const proxy = new Proxy({} as Record<string, Record<string, ColumnNode>>, {
    get(_target, tableName: string) {
      if (typeof tableName !== "string") return undefined;

      const schema = schemas[tableName];
      const shape = schema ? (schema as unknown as z.ZodObject<any>).shape : {};
      const columns = new Set(Object.keys(shape));

      aliasCounter++;
      const alias = `t${aliasCounter}`;
      const tableProxy = createTableProxy(tableName, alias, columns);

      const entries = aliases.get(tableName) || [];
      entries.push({ tableName, alias, proxy: tableProxy });
      aliases.set(tableName, entries);

      return tableProxy;
    },
  });

  return { proxy, aliasMap: aliases };
}

// ---------- Proxy Query Result ----------

type AnyColumn = ColumnNode | (ColumnNode & string);

export interface ProxyQueryResult {
  select: Record<string, AnyColumn | undefined>;
  join?:
    | [AnyColumn | undefined, AnyColumn | undefined]
    | [AnyColumn | undefined, AnyColumn | undefined][];
  where?: Record<string, any>;
  orderBy?: Record<string, "asc" | "desc">;
  limit?: number;
  offset?: number;
  groupBy?: (AnyColumn | undefined)[];
}

// ---------- Proxy Query Compiler ----------

function isColumnNode(val: any): val is ColumnNode {
  return val && typeof val === "object" && val._type === "COL";
}

export function compileProxyQuery(
  queryResult: ProxyQueryResult,
  aliasMap: Map<string, AliasEntry[]>,
): { sql: string; params: any[] } {
  const params: any[] = [];

  const tablesUsed = new Map<string, { tableName: string; alias: string }>();
  for (const [tableName, entries] of aliasMap) {
    for (const entry of entries) {
      tablesUsed.set(entry.alias, { tableName, alias: entry.alias });
    }
  }

  // SELECT
  const selectParts: string[] = [];
  for (const [outputName, colOrValue] of Object.entries(queryResult.select)) {
    if (isColumnNode(colOrValue)) {
      if (outputName === colOrValue.column) {
        selectParts.push(qRef(colOrValue.alias, colOrValue.column));
      } else {
        selectParts.push(
          `${qRef(colOrValue.alias, colOrValue.column)} AS ${q(outputName)}`,
        );
      }
    } else {
      selectParts.push(`? AS ${q(outputName)}`);
      params.push(colOrValue);
    }
  }

  // FROM / JOIN
  const allAliases = [...tablesUsed.values()];
  if (allAliases.length === 0)
    throw new Error("No tables referenced in query.");

  const primaryAlias = allAliases[0]!;
  let sql = `SELECT ${selectParts.join(", ")} FROM ${q(primaryAlias.tableName)} ${q(primaryAlias.alias)}`;

  if (queryResult.join) {
    const joins: [ColumnNode, ColumnNode][] = Array.isArray(queryResult.join[0])
      ? (queryResult.join as [ColumnNode, ColumnNode][])
      : [queryResult.join as [ColumnNode, ColumnNode]];

    for (const [left, right] of joins) {
      const leftTable = tablesUsed.get(left.alias);
      const rightTable = tablesUsed.get(right.alias);
      if (!leftTable || !rightTable)
        throw new Error("Join references unknown table alias.");
      const joinAlias =
        leftTable.alias === primaryAlias.alias ? rightTable : leftTable;
      sql += ` JOIN ${q(joinAlias.tableName)} ${q(joinAlias.alias)} ON ${qRef(left.alias, left.column)} = ${qRef(right.alias, right.column)}`;
    }
  }

  // WHERE
  if (queryResult.where && Object.keys(queryResult.where).length > 0) {
    const whereParts: string[] = [];

    for (const [key, value] of Object.entries(queryResult.where)) {
      let fieldRef: string;
      const quotedMatch = key.match(/^"([^"]+)"\."([^"]+)"$/);
      if (quotedMatch && tablesUsed.has(quotedMatch[1]!)) {
        fieldRef = key;
      } else {
        fieldRef = qRef(primaryAlias.alias, key);
      }

      if (isColumnNode(value)) {
        whereParts.push(`${fieldRef} = ${qRef(value.alias, value.column)}`);
      } else if (Array.isArray(value)) {
        if (value.length === 0) {
          whereParts.push("1 = 0");
        } else {
          const placeholders = value.map(() => "?").join(", ");
          whereParts.push(`${fieldRef} IN (${placeholders})`);
          params.push(...value);
        }
      } else if (
        typeof value === "object" &&
        value !== null &&
        !(value instanceof Date)
      ) {
        for (const [pOp, operand] of Object.entries(value)) {
          if (pOp === "$in") {
            const arr = operand as any[];
            if (arr.length === 0) {
              whereParts.push("1 = 0");
            } else {
              const placeholders = arr.map(() => "?").join(", ");
              whereParts.push(`${fieldRef} IN (${placeholders})`);
              params.push(...arr);
            }
            continue;
          }
          const opMap: Record<string, string> = {
            $gt: ">",
            $gte: ">=",
            $lt: "<",
            $lte: "<=",
            $ne: "!=",
          };
          const sqlOp = opMap[pOp];
          if (!sqlOp) throw new Error(`Unsupported where operator: ${pOp}`);
          whereParts.push(`${fieldRef} ${sqlOp} ?`);
          params.push(operand);
        }
      } else {
        whereParts.push(`${fieldRef} = ?`);
        params.push(value instanceof Date ? value.toISOString() : value);
      }
    }

    if (whereParts.length > 0) {
      sql += ` WHERE ${whereParts.join(" AND ")}`;
    }
  }

  // ORDER BY
  if (queryResult.orderBy) {
    const parts: string[] = [];
    for (const [key, dir] of Object.entries(queryResult.orderBy)) {
      let fieldRef: string;
      const quotedMatch = key.match(/^"([^"]+)"\."([^"]+)"$/);
      if (quotedMatch && tablesUsed.has(quotedMatch[1]!)) {
        fieldRef = key;
      } else {
        fieldRef = qRef(primaryAlias.alias, key);
      }
      parts.push(`${fieldRef} ${dir.toUpperCase()}`);
    }
    if (parts.length > 0) {
      sql += ` ORDER BY ${parts.join(", ")}`;
    }
  }

  // GROUP BY
  if (queryResult.groupBy && queryResult.groupBy.length > 0) {
    const parts = queryResult.groupBy
      .filter(Boolean)
      .map((col) => qRef(col!.alias, col!.column));
    sql += ` GROUP BY ${parts.join(", ")}`;
  }

  // LIMIT / OFFSET
  if (queryResult.limit !== undefined) sql += ` LIMIT ${queryResult.limit}`;
  if (queryResult.offset !== undefined) sql += ` OFFSET ${queryResult.offset}`;

  return { sql, params };
}

/** The main `db.query(c => {...})` entry point. */
export function executeProxyQuery<T>(
  schemas: Record<string, z.ZodType<any>>,
  callback: (ctx: any) => ProxyQueryResult,
  executor: (sql: string, params: any[]) => T[],
): T[] {
  const { proxy, aliasMap } = createContextProxy(schemas);
  const queryResult = callback(proxy);
  const { sql, params } = compileProxyQuery(queryResult, aliasMap);
  return executor(sql, params);
}
