import { z } from 'zod';

// ---------- SQL Identifier Quoting ----------

/** Quote an identifier (table name, alias, column) to handle reserved words. */
function q(name: string): string {
    return `"${name}"`;
}

/** Quote a fully qualified alias.column reference. */
function qRef(alias: string, column: string): string {
    return `${q(alias)}.${q(column)}`;
}

// ---------- AST Node Types ----------

/** Represents a column reference in the query AST. */
export class ColumnNode {
    readonly _type = 'COL' as const;
    readonly table: string;
    readonly column: string;
    readonly alias: string;

    constructor(table: string, column: string, alias: string) {
        this.table = table;
        this.column = column;
        this.alias = alias;
    }

    /** 
     * When used as object key via `[t.id]`, JS calls toString().
     * This returns the qualified column name for the ORM to parse.
     */
    toString(): string {
        return `${q(this.alias)}.${q(this.column)}`;
    }

    /** Also override valueOf for numeric contexts. */
    valueOf(): string {
        return this.toString();
    }

    /** Convenience for Symbol.toPrimitive */
    [Symbol.toPrimitive](hint: string): string {
        return this.toString();
    }
}

// ---------- Table Proxy ----------

/**
 * Creates a proxy representing a table with a given alias.
 * Property access returns ColumnNode objects.
 */
function createTableProxy(
    tableName: string,
    alias: string,
    columns: Set<string>,
): Record<string, ColumnNode> {
    return new Proxy({} as Record<string, ColumnNode>, {
        get(_target, prop: string): ColumnNode | undefined {
            if (prop === Symbol.toPrimitive as any || prop === 'toString' || prop === 'valueOf') {
                return undefined;
            }
            // Allow any property access — the column may be inferred or wildcard
            return new ColumnNode(tableName, prop, alias);
        },
        ownKeys() {
            return [...columns];
        },
        getOwnPropertyDescriptor(_target, prop) {
            if (columns.has(prop as string)) {
                return { configurable: true, enumerable: true, value: new ColumnNode(tableName, prop as string, alias) };
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

/**
 * Creates the root context proxy `c` that the user destructures.
 * Each table access generates a unique alias.
 */
export function createContextProxy(
    schemas: Record<string, z.ZodType<any>>,
): { proxy: Record<string, Record<string, ColumnNode>>; aliasMap: Map<string, AliasEntry[]> } {
    const aliases = new Map<string, AliasEntry[]>();
    let aliasCounter = 0;

    const proxy = new Proxy({} as Record<string, Record<string, ColumnNode>>, {
        get(_target, tableName: string) {
            if (typeof tableName !== 'string') return undefined;

            const schema = schemas[tableName];
            const columns = schema
                ? new Set(Object.keys((schema as unknown as z.ZodObject<any>).shape))
                : new Set<string>();

            aliasCounter++;
            const alias = `t${aliasCounter}`;
            const tableProxy = createTableProxy(tableName, alias, columns);

            // Track alias
            const entries = aliases.get(tableName) || [];
            entries.push({ tableName, alias, proxy: tableProxy });
            aliases.set(tableName, entries);

            return tableProxy;
        },
    });

    return { proxy, aliasMap: aliases };
}

// ---------- Query Result Shape ----------

export interface ProxyQueryResult {
    select: Record<string, ColumnNode>;
    join?: [ColumnNode, ColumnNode] | [ColumnNode, ColumnNode][];
    where?: Record<string, any>;
    orderBy?: Record<string, 'asc' | 'desc'>;
    limit?: number;
    offset?: number;
    groupBy?: ColumnNode[];
}

// ---------- Query Compiler ----------

function isColumnNode(val: any): val is ColumnNode {
    return val && typeof val === 'object' && val._type === 'COL';
}

/**
 * Compile the result of the user's callback into SQL.
 */
export function compileProxyQuery(
    queryResult: ProxyQueryResult,
    aliasMap: Map<string, AliasEntry[]>,
): { sql: string; params: any[] } {
    const params: any[] = [];

    // Collect all tables/aliases referenced
    const tablesUsed = new Map<string, { tableName: string; alias: string }>();

    for (const [tableName, entries] of aliasMap) {
        for (const entry of entries) {
            tablesUsed.set(entry.alias, { tableName, alias: entry.alias });
        }
    }

    // ---------- SELECT ----------
    const selectParts: string[] = [];
    for (const [outputName, colOrValue] of Object.entries(queryResult.select)) {
        if (isColumnNode(colOrValue)) {
            if (outputName === colOrValue.column) {
                selectParts.push(qRef(colOrValue.alias, colOrValue.column));
            } else {
                selectParts.push(`${qRef(colOrValue.alias, colOrValue.column)} AS ${q(outputName)}`);
            }
        } else {
            // Literal value
            selectParts.push(`? AS ${q(outputName)}`);
            params.push(colOrValue);
        }
    }

    // ---------- FROM / JOIN ----------
    // First table in aliases is the primary; rest are joined
    const allAliases = [...tablesUsed.values()];
    if (allAliases.length === 0) throw new Error('No tables referenced in query.');

    const primaryAlias = allAliases[0]!;
    let sql = `SELECT ${selectParts.join(', ')} FROM ${q(primaryAlias.tableName)} ${q(primaryAlias.alias)}`;

    // Process JOINs
    if (queryResult.join) {
        const joins: [ColumnNode, ColumnNode][] = Array.isArray(queryResult.join[0])
            ? queryResult.join as [ColumnNode, ColumnNode][]
            : [queryResult.join as [ColumnNode, ColumnNode]];

        for (const [left, right] of joins) {
            // Determine which side is the joined table (not the primary)
            const leftTable = tablesUsed.get(left.alias);
            const rightTable = tablesUsed.get(right.alias);

            if (!leftTable || !rightTable) throw new Error('Join references unknown table alias.');

            // The non-primary side needs a JOIN clause
            const joinAlias = leftTable.alias === primaryAlias.alias ? rightTable : leftTable;

            sql += ` JOIN ${q(joinAlias.tableName)} ${q(joinAlias.alias)} ON ${qRef(left.alias, left.column)} = ${qRef(right.alias, right.column)}`;
        }
    }

    // ---------- WHERE ----------
    if (queryResult.where && Object.keys(queryResult.where).length > 0) {
        const whereParts: string[] = [];

        for (const [key, value] of Object.entries(queryResult.where)) {
            // The key could be '"t1"."column"' (from toString trick) or a plain string
            let fieldRef: string;

            // Match quoted alias.column pattern: "alias"."column"
            const quotedMatch = key.match(/^"([^"]+)"\."([^"]+)"$/);
            if (quotedMatch && tablesUsed.has(quotedMatch[1]!)) {
                // Already fully quoted
                fieldRef = key;
            } else {
                // Plain field name — use the first table
                fieldRef = qRef(primaryAlias.alias, key);
            }

            if (isColumnNode(value)) {
                // Column-to-column comparison
                whereParts.push(`${fieldRef} = ${qRef(value.alias, value.column)}`);
            } else if (Array.isArray(value)) {
                if (value.length === 0) {
                    whereParts.push('1 = 0');
                } else {
                    const placeholders = value.map(() => '?').join(', ');
                    whereParts.push(`${fieldRef} IN (${placeholders})`);
                    params.push(...value);
                }
            } else if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
                // Operator object like { $gt: 5 }
                for (const [op, operand] of Object.entries(value)) {
                    if (op === '$in') {
                        const arr = operand as any[];
                        if (arr.length === 0) {
                            whereParts.push('1 = 0');
                        } else {
                            const placeholders = arr.map(() => '?').join(', ');
                            whereParts.push(`${fieldRef} IN (${placeholders})`);
                            params.push(...arr);
                        }
                        continue;
                    }
                    const opMap: Record<string, string> = {
                        $gt: '>', $gte: '>=', $lt: '<', $lte: '<=', $ne: '!=',
                    };
                    const sqlOp = opMap[op];
                    if (!sqlOp) throw new Error(`Unsupported where operator: ${op}`);
                    whereParts.push(`${fieldRef} ${sqlOp} ?`);
                    params.push(operand);
                }
            } else {
                whereParts.push(`${fieldRef} = ?`);
                params.push(value instanceof Date ? value.toISOString() : value);
            }
        }

        if (whereParts.length > 0) {
            sql += ` WHERE ${whereParts.join(' AND ')}`;
        }
    }

    // ---------- ORDER BY ----------
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
            sql += ` ORDER BY ${parts.join(', ')}`;
        }
    }

    // ---------- GROUP BY ----------
    if (queryResult.groupBy && queryResult.groupBy.length > 0) {
        const parts = queryResult.groupBy.map(col => qRef(col.alias, col.column));
        sql += ` GROUP BY ${parts.join(', ')}`;
    }

    // ---------- LIMIT / OFFSET ----------
    if (queryResult.limit !== undefined) {
        sql += ` LIMIT ${queryResult.limit}`;
    }
    if (queryResult.offset !== undefined) {
        sql += ` OFFSET ${queryResult.offset}`;
    }

    return { sql, params };
}

// ---------- Public API ----------

/**
 * The main `db.query(c => {...})` entry point.
 * 
 * @param schemas The schema map for all registered tables.
 * @param callback The user's query callback that receives the context proxy.
 * @param executor A function that runs the compiled SQL and returns rows.
 * @returns The query results.
 */
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
