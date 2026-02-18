/**
 * query.ts — Unified query module for sqlite-zod-orm
 *
 * Contains:
 * - IQO (Internal Query Object) types and SQL compiler
 * - QueryBuilder class (fluent chaining, subscribe, each)
 * - Proxy query system (db.query() with destructured table aliases)
 * - QueryBuilder factory (wires executors, resolvers, and loaders)
 */
import { z } from 'zod';
import {
    type ASTNode, type WhereCallback, type TypedColumnProxy, type FunctionProxy, type Operators,
    compileAST, wrapNode, createColumnProxy, createFunctionProxy, op,
} from './ast';
import { transformFromStorage } from './schema';
import type { DatabaseContext } from './context';

// =============================================================================
// IQO — Internal Query Object
// =============================================================================

type OrderDirection = 'asc' | 'desc';
type WhereOperator = '$gt' | '$gte' | '$lt' | '$lte' | '$ne' | '$in';

interface WhereCondition {
    field: string;
    operator: '=' | '>' | '>=' | '<' | '<=' | '!=' | 'IN';
    value: any;
}

interface JoinClause {
    table: string;
    fromCol: string;
    toCol: string;
    columns: string[];   // columns to SELECT from the joined table
}

interface IQO {
    selects: string[];
    wheres: WhereCondition[];
    whereOrs: WhereCondition[][];  // Each sub-array is an OR group
    whereAST: ASTNode | null;
    joins: JoinClause[];
    limit: number | null;
    offset: number | null;
    orderBy: { field: string; direction: OrderDirection }[];
    includes: string[];
    raw: boolean;
}

const OPERATOR_MAP: Record<WhereOperator, string> = {
    $gt: '>',
    $gte: '>=',
    $lt: '<',
    $lte: '<=',
    $ne: '!=',
    $in: 'IN',
};

function transformValueForStorage(value: any): any {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
}

/**
 * Compile an Internal Query Object into executable SQL + params.
 * Handles SELECT, JOIN, WHERE (object + AST + $or), ORDER BY, LIMIT, OFFSET.
 */
export function compileIQO(tableName: string, iqo: IQO): { sql: string; params: any[] } {
    const params: any[] = [];

    // SELECT clause
    const selectParts: string[] = [];
    if (iqo.selects.length > 0) {
        selectParts.push(...iqo.selects.map(s => `${tableName}.${s}`));
    } else {
        selectParts.push(`${tableName}.*`);
    }
    for (const j of iqo.joins) {
        if (j.columns.length > 0) {
            selectParts.push(...j.columns.map(c => `${j.table}.${c} AS ${j.table}_${c}`));
        } else {
            selectParts.push(`${j.table}.*`);
        }
    }

    let sql = `SELECT ${selectParts.join(', ')} FROM ${tableName}`;

    // JOIN clauses
    for (const j of iqo.joins) {
        sql += ` JOIN ${j.table} ON ${tableName}.${j.fromCol} = ${j.table}.${j.toCol}`;
    }

    // WHERE clause — AST-based takes precedence if set
    if (iqo.whereAST) {
        const compiled = compileAST(iqo.whereAST);
        sql += ` WHERE ${compiled.sql}`;
        params.push(...compiled.params);
    } else if (iqo.wheres.length > 0) {
        const hasJoins = iqo.joins.length > 0;
        const qualify = (field: string) =>
            hasJoins && !field.includes('.') ? `${tableName}.${field}` : field;

        const whereParts: string[] = [];
        for (const w of iqo.wheres) {
            if (w.operator === 'IN') {
                const arr = w.value as any[];
                if (arr.length === 0) {
                    whereParts.push('1 = 0');
                } else {
                    const placeholders = arr.map(() => '?').join(', ');
                    whereParts.push(`${qualify(w.field)} IN (${placeholders})`);
                    params.push(...arr.map(transformValueForStorage));
                }
            } else {
                whereParts.push(`${qualify(w.field)} ${w.operator} ?`);
                params.push(transformValueForStorage(w.value));
            }
        }
        sql += ` WHERE ${whereParts.join(' AND ')}`;
    }

    // Append OR groups (from $or)
    if (iqo.whereOrs.length > 0) {
        for (const orGroup of iqo.whereOrs) {
            const orParts: string[] = [];
            for (const w of orGroup) {
                if (w.operator === 'IN') {
                    const arr = w.value as any[];
                    if (arr.length === 0) {
                        orParts.push('1 = 0');
                    } else {
                        orParts.push(`${w.field} IN (${arr.map(() => '?').join(', ')})`);
                        params.push(...arr.map(transformValueForStorage));
                    }
                } else {
                    orParts.push(`${w.field} ${w.operator} ?`);
                    params.push(transformValueForStorage(w.value));
                }
            }
            if (orParts.length > 0) {
                const orClause = `(${orParts.join(' OR ')})`;
                sql += sql.includes(' WHERE ') ? ` AND ${orClause}` : ` WHERE ${orClause}`;
            }
        }
    }

    // ORDER BY
    if (iqo.orderBy.length > 0) {
        const parts = iqo.orderBy.map(o => `${o.field} ${o.direction.toUpperCase()}`);
        sql += ` ORDER BY ${parts.join(', ')}`;
    }

    if (iqo.limit !== null) sql += ` LIMIT ${iqo.limit}`;
    if (iqo.offset !== null) sql += ` OFFSET ${iqo.offset}`;

    return { sql, params };
}

// =============================================================================
// QueryBuilder Class
// =============================================================================

/**
 * A Fluent Query Builder that accumulates query state via chaining
 * and only executes when a terminal method is called (.all(), .get())
 * or when it is `await`-ed (thenable).
 *
 * Supports two WHERE styles:
 * - Object-style: `.where({ name: 'Alice', age: { $gt: 18 } })`
 * - Callback-style (AST): `.where((c, f, op) => op.and(op.eq(c.name, 'Alice'), op.gt(c.age, 18)))`
 */
export class QueryBuilder<T extends Record<string, any>> {
    private iqo: IQO;
    private tableName: string;
    private executor: (sql: string, params: any[], raw: boolean) => any[];
    private singleExecutor: (sql: string, params: any[], raw: boolean) => any | null;
    private joinResolver: ((fromTable: string, toTable: string) => { fk: string; pk: string } | null) | null;
    private conditionResolver: ((conditions: Record<string, any>) => Record<string, any>) | null;
    private revisionGetter: (() => string) | null;
    private eagerLoader: ((parentTable: string, relation: string, parentIds: number[]) => { key: string; groups: Map<number, any[]> } | null) | null;
    private defaultPollInterval: number;

    constructor(
        tableName: string,
        executor: (sql: string, params: any[], raw: boolean) => any[],
        singleExecutor: (sql: string, params: any[], raw: boolean) => any | null,
        joinResolver?: ((fromTable: string, toTable: string) => { fk: string; pk: string } | null) | null,
        conditionResolver?: ((conditions: Record<string, any>) => Record<string, any>) | null,
        revisionGetter?: (() => string) | null,
        eagerLoader?: ((parentTable: string, relation: string, parentIds: number[]) => { key: string; groups: Map<number, any[]> } | null) | null,
        pollInterval?: number,
    ) {
        this.tableName = tableName;
        this.executor = executor;
        this.singleExecutor = singleExecutor;
        this.joinResolver = joinResolver ?? null;
        this.conditionResolver = conditionResolver ?? null;
        this.revisionGetter = revisionGetter ?? null;
        this.eagerLoader = eagerLoader ?? null;
        this.defaultPollInterval = pollInterval ?? 500;
        this.iqo = {
            selects: [],
            wheres: [],
            whereOrs: [],
            whereAST: null,
            joins: [],
            limit: null,
            offset: null,
            orderBy: [],
            includes: [],
            raw: false,
        };
    }

    /** Specify which columns to select. If called with no arguments, defaults to `*`. */
    select(...cols: (keyof T & string)[]): this {
        this.iqo.selects.push(...cols);
        return this;
    }

    /**
     * Add WHERE conditions. Two calling styles:
     *
     * **Object-style** (simple equality and operators):
     * ```ts
     * .where({ name: 'Alice' })
     * .where({ age: { $gt: 18 } })
     * ```
     *
     * **Callback-style** (AST-based, full SQL expression power):
     * ```ts
     * .where((c, f, op) => op.and(
     *   op.eq(f.lower(c.name), 'alice'),
     *   op.gt(c.age, 18)
     * ))
     * ```
     */
    where(criteriaOrCallback: (Partial<Record<keyof T & string, any>> & { $or?: Partial<Record<keyof T & string, any>>[] }) | WhereCallback<T>): this {
        if (typeof criteriaOrCallback === 'function') {
            const ast = (criteriaOrCallback as WhereCallback<T>)(
                createColumnProxy<T>(),
                createFunctionProxy(),
                op,
            );
            if (this.iqo.whereAST) {
                this.iqo.whereAST = { type: 'operator', op: 'AND', left: this.iqo.whereAST, right: ast };
            } else {
                this.iqo.whereAST = ast;
            }
        } else {
            const resolved = this.conditionResolver
                ? this.conditionResolver(criteriaOrCallback as Record<string, any>)
                : criteriaOrCallback;

            for (const [key, value] of Object.entries(resolved)) {
                if (key === '$or' && Array.isArray(value)) {
                    const orConditions: WhereCondition[] = [];
                    for (const branch of value as Record<string, any>[]) {
                        const resolvedBranch = this.conditionResolver
                            ? this.conditionResolver(branch)
                            : branch;
                        for (const [bKey, bValue] of Object.entries(resolvedBranch)) {
                            if (typeof bValue === 'object' && bValue !== null && !Array.isArray(bValue) && !(bValue instanceof Date)) {
                                for (const [opKey, operand] of Object.entries(bValue)) {
                                    const sqlOp = OPERATOR_MAP[opKey as WhereOperator];
                                    if (sqlOp) orConditions.push({ field: bKey, operator: sqlOp as WhereCondition['operator'], value: operand });
                                }
                            } else {
                                orConditions.push({ field: bKey, operator: '=', value: bValue });
                            }
                        }
                    }
                    if (orConditions.length > 0) this.iqo.whereOrs.push(orConditions);
                    continue;
                }

                if (typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)) {
                    for (const [opKey, operand] of Object.entries(value)) {
                        const sqlOp = OPERATOR_MAP[opKey as WhereOperator];
                        if (!sqlOp) throw new Error(`Unsupported query operator: '${opKey}' on field '${key}'.`);
                        this.iqo.wheres.push({
                            field: key,
                            operator: sqlOp as WhereCondition['operator'],
                            value: operand,
                        });
                    }
                } else {
                    this.iqo.wheres.push({ field: key, operator: '=', value });
                }
            }
        }
        return this;
    }

    /** Set the maximum number of rows to return. */
    limit(n: number): this {
        this.iqo.limit = n;
        return this;
    }

    /** Set the offset for pagination. */
    offset(n: number): this {
        this.iqo.offset = n;
        return this;
    }

    /** Add ORDER BY clauses. */
    orderBy(field: keyof T & string, direction: OrderDirection = 'asc'): this {
        this.iqo.orderBy.push({ field, direction });
        return this;
    }

    /**
     * Join another table. Two calling styles:
     *
     * **Accessor-based** (auto-infers FK from relationships):
     * ```ts
     * db.trees.select('name').join(db.forests, ['name']).all()
     * ```
     *
     * **String-based** (manual FK):
     * ```ts
     * db.trees.select('name').join('forests', 'forestId', ['name']).all()
     * ```
     */
    join(accessor: { _tableName: string }, columns?: string[]): this;
    join(table: string, fk: string, columns?: string[], pk?: string): this;
    join(tableOrAccessor: string | { _tableName: string }, fkOrCols?: string | string[], colsOrPk?: string[] | string, pk?: string): this {
        let table: string;
        let fromCol: string;
        let toCol: string;
        let columns: string[];

        if (typeof tableOrAccessor === 'object' && '_tableName' in tableOrAccessor) {
            table = tableOrAccessor._tableName;
            columns = Array.isArray(fkOrCols) ? fkOrCols : [];
            if (!this.joinResolver) throw new Error(`Cannot auto-resolve join: no relationship data available`);
            const resolved = this.joinResolver(this.tableName, table);
            if (!resolved) throw new Error(`No relationship found between '${this.tableName}' and '${table}'`);
            fromCol = resolved.fk;
            toCol = resolved.pk;
        } else {
            table = tableOrAccessor;
            fromCol = fkOrCols as string;
            columns = Array.isArray(colsOrPk) ? colsOrPk : [];
            toCol = (typeof colsOrPk === 'string' ? colsOrPk : pk) ?? 'id';
        }

        this.iqo.joins.push({ table, fromCol, toCol, columns });
        this.iqo.raw = true;
        return this;
    }

    /** Skip Zod parsing and return raw SQLite row objects. */
    raw(): this {
        this.iqo.raw = true;
        return this;
    }

    /**
     * Eagerly load a related entity and attach as an array property.
     *
     * Runs a single batched query (WHERE fk IN (...)) per relation,
     * avoiding the N+1 problem of lazy navigation.
     */
    with(...relations: string[]): this {
        this.iqo.includes.push(...relations);
        return this;
    }

    /** Internal: apply eager loads to a set of results */
    private _applyEagerLoads(results: T[]): T[] {
        if (this.iqo.includes.length === 0 || !this.eagerLoader || results.length === 0) {
            return results;
        }

        const parentIds = results.map((r: any) => r.id).filter((id: any) => typeof id === 'number');
        if (parentIds.length === 0) return results;

        for (const relation of this.iqo.includes) {
            const loaded = this.eagerLoader(this.tableName, relation, parentIds);
            if (!loaded) continue;

            for (const row of results as any[]) {
                row[loaded.key] = loaded.groups.get(row.id) ?? [];
            }
        }

        return results;
    }

    // ---------- Terminal / Execution Methods ----------

    /** Execute the query and return all matching rows. */
    all(): T[] {
        const { sql, params } = compileIQO(this.tableName, this.iqo);
        const results = this.executor(sql, params, this.iqo.raw);
        return this._applyEagerLoads(results);
    }

    /** Execute the query and return the first matching row, or null. */
    get(): T | null {
        this.iqo.limit = 1;
        const { sql, params } = compileIQO(this.tableName, this.iqo);
        const result = this.singleExecutor(sql, params, this.iqo.raw);
        if (!result) return null;
        const [loaded] = this._applyEagerLoads([result]);
        return loaded ?? null;
    }

    /** Execute the query and return the count of matching rows. */
    count(): number {
        const params: any[] = [];
        let sql = `SELECT COUNT(*) as count FROM ${this.tableName}`;

        if (this.iqo.whereAST) {
            const compiled = compileAST(this.iqo.whereAST);
            sql += ` WHERE ${compiled.sql}`;
            params.push(...compiled.params);
        } else if (this.iqo.wheres.length > 0) {
            const whereParts: string[] = [];
            for (const w of this.iqo.wheres) {
                if (w.operator === 'IN') {
                    const arr = w.value as any[];
                    if (arr.length === 0) {
                        whereParts.push('1 = 0');
                    } else {
                        const placeholders = arr.map(() => '?').join(', ');
                        whereParts.push(`${w.field} IN (${placeholders})`);
                        params.push(...arr.map(transformValueForStorage));
                    }
                } else {
                    whereParts.push(`${w.field} ${w.operator} ?`);
                    params.push(transformValueForStorage(w.value));
                }
            }
            sql += ` WHERE ${whereParts.join(' AND ')}`;
        }

        const results = this.executor(sql, params, true);
        return (results[0] as any)?.count ?? 0;
    }

    // ---------- Subscribe (Smart Polling) ----------

    /**
     * Subscribe to query result changes using smart interval-based polling.
     *
     * Uses trigger-based change detection combined with an in-memory revision
     * counter to detect ALL changes (inserts, updates, deletes) with minimal overhead.
     */
    subscribe(
        callback: (rows: T[]) => void | Promise<void>,
        options: { interval?: number; immediate?: boolean } = {},
    ): () => void {
        const { interval = this.defaultPollInterval, immediate = true } = options;

        let lastRevision: string | null = null;
        let stopped = false;

        const poll = async () => {
            if (stopped) return;
            try {
                const rev = this.revisionGetter?.() ?? '0';
                if (rev !== lastRevision) {
                    lastRevision = rev;
                    const rows = this.all();
                    await callback(rows);
                }
            } catch {
                // Silently skip on error (table might be in transition)
            }
            if (!stopped) setTimeout(poll, interval);
        };

        if (immediate) {
            poll();
        } else {
            setTimeout(poll, interval);
        }

        return () => { stopped = true; };
    }

    /**
     * Stream new rows one at a time via a watermark (last seen id).
     *
     * Unlike `.subscribe()` (which gives you an array snapshot), `.each()`
     * calls your callback once per new row, in insertion order.
     */
    each(
        callback: (row: T) => void | Promise<void>,
        options: { interval?: number } = {},
    ): () => void {
        const { interval = this.defaultPollInterval } = options;

        const userWhere = this.buildWhereClause();

        const maxRows = this.executor(
            `SELECT MAX(id) as _max FROM ${this.tableName} ${userWhere.sql ? `WHERE ${userWhere.sql}` : ''}`,
            userWhere.params,
            true
        );
        let lastMaxId: number = (maxRows[0] as any)?._max ?? 0;
        let lastRevision = this.revisionGetter?.() ?? '0';
        let stopped = false;

        const poll = async () => {
            if (stopped) return;

            const rev = this.revisionGetter?.() ?? '0';
            if (rev !== lastRevision) {
                lastRevision = rev;

                const params = [...userWhere.params, lastMaxId];
                const whereClause = userWhere.sql
                    ? `WHERE ${userWhere.sql} AND id > ? ORDER BY id ASC`
                    : `WHERE id > ? ORDER BY id ASC`;
                const sql = `SELECT * FROM ${this.tableName} ${whereClause}`;

                const newRows = this.executor(sql, params, false);

                for (const row of newRows) {
                    if (stopped) return;
                    await callback(row as T);
                    lastMaxId = (row as any).id;
                }
            }

            if (!stopped) setTimeout(poll, interval);
        };

        setTimeout(poll, interval);
        return () => { stopped = true; };
    }

    /** Compile the IQO's WHERE conditions into a SQL fragment + params (without the WHERE keyword). */
    private buildWhereClause(): { sql: string; params: any[] } {
        const params: any[] = [];

        if (this.iqo.whereAST) {
            const compiled = compileAST(this.iqo.whereAST);
            return { sql: compiled.sql, params: compiled.params };
        }

        if (this.iqo.wheres.length > 0) {
            const whereParts: string[] = [];
            for (const w of this.iqo.wheres) {
                if (w.operator === 'IN') {
                    const arr = w.value as any[];
                    if (arr.length === 0) {
                        whereParts.push('1 = 0');
                    } else {
                        const placeholders = arr.map(() => '?').join(', ');
                        whereParts.push(`${w.field} IN (${placeholders})`);
                        params.push(...arr.map(transformValueForStorage));
                    }
                } else {
                    whereParts.push(`${w.field} ${w.operator} ?`);
                    params.push(transformValueForStorage(w.value));
                }
            }
            return { sql: whereParts.join(' AND '), params };
        }

        return { sql: '', params: [] };
    }

    // ---------- Thenable (async/await support) ----------

    then<TResult1 = T[], TResult2 = never>(
        onfulfilled?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
        try {
            const result = this.all();
            return Promise.resolve(result).then(onfulfilled, onrejected);
        } catch (err) {
            return Promise.reject(err).then(onfulfilled, onrejected);
        }
    }
}

// =============================================================================
// Proxy Query System
// =============================================================================

/**
 * Represents a reference to a specific table column with an alias.
 * Used as a building block for SQL query construction.
 */
export class ColumnNode {
    readonly _type = 'COL' as const;
    constructor(
        readonly table: string,
        readonly column: string,
        readonly alias: string,
    ) { }

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
            if (prop === Symbol.toPrimitive as any || prop === 'toString' || prop === 'valueOf') {
                return undefined;
            }
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

export function createContextProxy(
    schemas: Record<string, z.ZodType<any>>,
): { proxy: Record<string, Record<string, ColumnNode>>; aliasMap: Map<string, AliasEntry[]> } {
    const aliases = new Map<string, AliasEntry[]>();
    let aliasCounter = 0;

    const proxy = new Proxy({} as Record<string, Record<string, ColumnNode>>, {
        get(_target, tableName: string) {
            if (typeof tableName !== 'string') return undefined;

            const schema = schemas[tableName];
            const shape = schema
                ? (schema as unknown as z.ZodObject<any>).shape
                : {};
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
    join?: [AnyColumn | undefined, AnyColumn | undefined] | [AnyColumn | undefined, AnyColumn | undefined][];
    where?: Record<string, any>;
    orderBy?: Record<string, 'asc' | 'desc'>;
    limit?: number;
    offset?: number;
    groupBy?: (AnyColumn | undefined)[];
}

// ---------- Proxy Query Compiler ----------

function isColumnNode(val: any): val is ColumnNode {
    return val && typeof val === 'object' && val._type === 'COL';
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
                selectParts.push(`${qRef(colOrValue.alias, colOrValue.column)} AS ${q(outputName)}`);
            }
        } else {
            selectParts.push(`? AS ${q(outputName)}`);
            params.push(colOrValue);
        }
    }

    // FROM / JOIN
    const allAliases = [...tablesUsed.values()];
    if (allAliases.length === 0) throw new Error('No tables referenced in query.');

    const primaryAlias = allAliases[0]!;
    let sql = `SELECT ${selectParts.join(', ')} FROM ${q(primaryAlias.tableName)} ${q(primaryAlias.alias)}`;

    if (queryResult.join) {
        const joins: [ColumnNode, ColumnNode][] = Array.isArray(queryResult.join[0])
            ? queryResult.join as [ColumnNode, ColumnNode][]
            : [queryResult.join as [ColumnNode, ColumnNode]];

        for (const [left, right] of joins) {
            const leftTable = tablesUsed.get(left.alias);
            const rightTable = tablesUsed.get(right.alias);
            if (!leftTable || !rightTable) throw new Error('Join references unknown table alias.');
            const joinAlias = leftTable.alias === primaryAlias.alias ? rightTable : leftTable;
            sql += ` JOIN ${q(joinAlias.tableName)} ${q(joinAlias.alias)} ON ${qRef(left.alias, left.column)} = ${qRef(right.alias, right.column)}`;
        }
    }

    // WHERE
    if (queryResult.where && Object.keys(queryResult.where).length > 0) {
        const whereParts: string[] = [];

        for (const [key, value] of Object.entries(queryResult.where)) {
            let fieldRef: string;
            const quotedMatch = key.match(/^"([^"]+)"\.\"([^"]+)"$/);
            if (quotedMatch && tablesUsed.has(quotedMatch[1]!)) {
                fieldRef = key;
            } else {
                fieldRef = qRef(primaryAlias.alias, key);
            }

            if (isColumnNode(value)) {
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
                for (const [pOp, operand] of Object.entries(value)) {
                    if (pOp === '$in') {
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
            sql += ` WHERE ${whereParts.join(' AND ')}`;
        }
    }

    // ORDER BY
    if (queryResult.orderBy) {
        const parts: string[] = [];
        for (const [key, dir] of Object.entries(queryResult.orderBy)) {
            let fieldRef: string;
            const quotedMatch = key.match(/^"([^"]+)"\.\"([^"]+)"$/);
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

    // GROUP BY
    if (queryResult.groupBy && queryResult.groupBy.length > 0) {
        const parts = queryResult.groupBy.filter(Boolean).map(col => qRef(col!.alias, col!.column));
        sql += ` GROUP BY ${parts.join(', ')}`;
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

// =============================================================================
// QueryBuilder Factory
// =============================================================================

/**
 * Create a QueryBuilder instance wired to the database.
 *
 * Constructs all the closures (executor, joinResolver, conditionResolver,
 * revisionGetter, eagerLoader) that the QueryBuilder needs to execute
 * queries against the actual SQLite database.
 */
export function createQueryBuilder(ctx: DatabaseContext, entityName: string, initialCols: string[]): QueryBuilder<any> {
    const schema = ctx.schemas[entityName]!;

    const executor = (sql: string, params: any[], raw: boolean): any[] => {
        const rows = ctx.db.query(sql).all(...params);
        if (raw) return rows;
        return rows.map((row: any) => ctx.attachMethods(entityName, transformFromStorage(row, schema)));
    };

    const singleExecutor = (sql: string, params: any[], raw: boolean): any | null => {
        const results = executor(sql, params, raw);
        return results.length > 0 ? results[0] : null;
    };

    const joinResolver = (fromTable: string, toTable: string): { fk: string; pk: string } | null => {
        const belongsTo = ctx.relationships.find(
            r => r.type === 'belongs-to' && r.from === fromTable && r.to === toTable
        );
        if (belongsTo) return { fk: belongsTo.foreignKey, pk: 'id' };
        const reverse = ctx.relationships.find(
            r => r.type === 'belongs-to' && r.from === toTable && r.to === fromTable
        );
        if (reverse) return { fk: 'id', pk: reverse.foreignKey };
        return null;
    };

    const revisionGetter = () => ctx.getRevision(entityName);

    const conditionResolver = (conditions: Record<string, any>): Record<string, any> => {
        const resolved: Record<string, any> = {};
        for (const [key, value] of Object.entries(conditions)) {
            if (value && typeof value === 'object' && typeof value.id === 'number' && typeof value.delete === 'function') {
                const fkCol = key + '_id';
                const rel = ctx.relationships.find(
                    r => r.type === 'belongs-to' && r.from === entityName && r.foreignKey === fkCol
                );
                if (rel) {
                    resolved[fkCol] = value.id;
                } else {
                    const relByNav = ctx.relationships.find(
                        r => r.type === 'belongs-to' && r.from === entityName && r.to === key + 's'
                    ) || ctx.relationships.find(
                        r => r.type === 'belongs-to' && r.from === entityName && r.to === key
                    );
                    if (relByNav) {
                        resolved[relByNav.foreignKey] = value.id;
                    } else {
                        resolved[key] = value;
                    }
                }
            } else {
                resolved[key] = value;
            }
        }
        return resolved;
    };

    const eagerLoader = (parentTable: string, relation: string, parentIds: number[]): { key: string; groups: Map<number, any[]> } | null => {
        const hasMany = ctx.relationships.find(
            r => r.type === 'one-to-many' && r.from === parentTable && r.relationshipField === relation
        );
        if (hasMany) {
            const belongsTo = ctx.relationships.find(
                r => r.type === 'belongs-to' && r.from === hasMany.to && r.to === parentTable
            );
            if (belongsTo) {
                const fk = belongsTo.foreignKey;
                const placeholders = parentIds.map(() => '?').join(', ');
                const childRows = ctx.db.query(
                    `SELECT * FROM ${hasMany.to} WHERE ${fk} IN (${placeholders})`
                ).all(...parentIds) as any[];

                const groups = new Map<number, any[]>();
                const childSchema = ctx.schemas[hasMany.to]!;
                for (const rawRow of childRows) {
                    const entity = ctx.attachMethods(
                        hasMany.to,
                        transformFromStorage(rawRow, childSchema)
                    );
                    const parentId = rawRow[fk] as number;
                    if (!groups.has(parentId)) groups.set(parentId, []);
                    groups.get(parentId)!.push(entity);
                }
                return { key: relation, groups };
            }
        }

        const belongsTo = ctx.relationships.find(
            r => r.type === 'belongs-to' && r.from === parentTable && r.relationshipField === relation
        );
        if (belongsTo) {
            return null;
        }

        return null;
    };

    const builder = new QueryBuilder(entityName, executor, singleExecutor, joinResolver, conditionResolver, revisionGetter, eagerLoader, ctx.pollInterval);
    if (initialCols.length > 0) builder.select(...initialCols);
    return builder;
}
