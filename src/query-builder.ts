import { z } from 'zod';
import {
    type ASTNode, type WhereCallback, type TypedColumnProxy, type FunctionProxy, type Operators,
    compileAST, wrapNode, createColumnProxy, createFunctionProxy, op,
} from './ast';

// ---------- Internal Query Object (IQO) ----------

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

// ---------- Operator mapping ----------

const OPERATOR_MAP: Record<WhereOperator, string> = {
    $gt: '>',
    $gte: '>=',
    $lt: '<',
    $lte: '<=',
    $ne: '!=',
    $in: 'IN',
};

// ---------- SQL Compilation ----------

function transformValueForStorage(value: any): any {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
}

export function compileIQO(tableName: string, iqo: IQO): { sql: string; params: any[] } {
    const params: any[] = [];

    // SELECT clause
    const selectParts: string[] = [];
    if (iqo.selects.length > 0) {
        selectParts.push(...iqo.selects.map(s => `${tableName}.${s}`));
    } else {
        selectParts.push(`${tableName}.*`);
    }
    // Add columns from joins
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
        // When joins exist, qualify bare column names with the main table
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

    // ORDER BY clause
    if (iqo.orderBy.length > 0) {
        const parts = iqo.orderBy.map(o => `${o.field} ${o.direction.toUpperCase()}`);
        sql += ` ORDER BY ${parts.join(', ')}`;
    }

    // LIMIT
    if (iqo.limit !== null) {
        sql += ` LIMIT ${iqo.limit}`;
    }

    // OFFSET
    if (iqo.offset !== null) {
        sql += ` OFFSET ${iqo.offset}`;
    }

    return { sql, params };
}

// ---------- QueryBuilder Class ----------

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

    /**
     * Specify which columns to select.
     * If called with no arguments, defaults to `*`.
     */
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
            // Callback-style: evaluate with proxies to produce AST
            const ast = (criteriaOrCallback as WhereCallback<T>)(
                createColumnProxy<T>(),
                createFunctionProxy(),
                op,
            );
            // If we already have an AST, AND them together
            if (this.iqo.whereAST) {
                this.iqo.whereAST = { type: 'operator', op: 'AND', left: this.iqo.whereAST, right: ast };
            } else {
                this.iqo.whereAST = ast;
            }
        } else {
            // Resolve entity references: { author: tolstoy } → { authorId: tolstoy.id }
            const resolved = this.conditionResolver
                ? this.conditionResolver(criteriaOrCallback as Record<string, any>)
                : criteriaOrCallback;

            // Object-style: parse into IQO conditions
            for (const [key, value] of Object.entries(resolved)) {
                // Handle $or: [{ field1: val1 }, { field2: val2 }]
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

    /**
     * Add ORDER BY clauses.
     * ```ts
     * .orderBy('name', 'asc')
     * .orderBy('createdAt', 'desc')
     * ```
     */
    orderBy(field: keyof T & string, direction: OrderDirection = 'asc'): this {
        this.iqo.orderBy.push({ field, direction });
        return this;
    }

    /**
     * Join another table. Two calling styles:
     *
     * **Accessor-based** (auto-infers FK from relationships, type-safe columns):
     * ```ts
     * db.trees.select('name').join(db.forests, ['name']).all()
     * // → [{ name: 'Oak', forests_name: 'Sherwood' }]
     * ```
     *
     * **String-based** (manual FK):
     * ```ts
     * db.trees.select('name').join('forests', 'forestId', ['name']).all()
     * ```
     */
    join(
        accessor: { _tableName: string },
        columns?: string[],
    ): this;
    join(
        table: string,
        fk: string,
        columns?: string[],
        pk?: string,
    ): this;
    join(tableOrAccessor: string | { _tableName: string }, fkOrCols?: string | string[], colsOrPk?: string[] | string, pk?: string): this {
        let table: string;
        let fromCol: string;
        let toCol: string;
        let columns: string[];

        if (typeof tableOrAccessor === 'object' && '_tableName' in tableOrAccessor) {
            // Accessor-based: .join(db.forests, ['name', 'address'])
            table = tableOrAccessor._tableName;
            columns = Array.isArray(fkOrCols) ? fkOrCols : [];

            // Auto-resolve FK from relationships
            if (!this.joinResolver) throw new Error(`Cannot auto-resolve join: no relationship data available`);
            const resolved = this.joinResolver(this.tableName, table);
            if (!resolved) throw new Error(`No relationship found between '${this.tableName}' and '${table}'`);
            fromCol = resolved.fk;
            toCol = resolved.pk;
        } else {
            // String-based: .join('forests', 'forestId', ['name'], 'id')
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
     * ```ts
     * const authors = db.authors.select().with('books').all();
     * // authors[0].books → [{ title: 'War and Peace', ... }, ...]
     * ```
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

        // WHERE — AST takes precedence
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
     * Uses a lightweight fingerprint (`COUNT(*), MAX(id)`) combined with an
     * in-memory revision counter to detect ALL changes (inserts, updates, deletes)
     * with zero disk overhead.
     *
     * Uses a self-scheduling async loop: each callback (sync or async) completes
     * before the next poll starts. No overlapping polls.
     *
     * ```ts
     * const unsub = db.messages.select()
     *   .where({ groupId: 1 })
     *   .orderBy('id', 'desc')
     *   .limit(20)
     *   .subscribe((rows) => {
     *     console.log('Messages updated:', rows);
     *   }, { interval: 1000 });
     *
     * // Later: stop listening
     * unsub();
     * ```
     *
     * @param callback  Called with the full result set whenever the data changes. Async callbacks are awaited.
     * @param options   `interval` in ms (default 500). Set `immediate` to false to skip the first call.
     * @returns An unsubscribe function.
     */
    subscribe(
        callback: (rows: T[]) => void | Promise<void>,
        options: { interval?: number; immediate?: boolean } = {},
    ): () => void {
        const { interval = this.defaultPollInterval, immediate = true } = options;

        // Build the fingerprint SQL (COUNT + MAX(id)) using the same WHERE
        const fingerprintSQL = this.buildFingerprintSQL();
        let lastCount: number | null = null;
        let lastMax: number | null = null;
        let lastInMemoryRev: string | null = null;
        let stopped = false;

        const poll = async () => {
            if (stopped) return;
            try {
                // Two-signal change detection:
                //   1. In-memory revision (table-specific) → catches same-process writes
                //   2. COUNT+MAX fingerprint (table-specific) → catches cross-process inserts/deletes
                //
                // Note: cross-process UPDATEs that don't change count/max are only caught
                // by PRAGMA data_version, which is database-wide. We accept this tradeoff
                // to avoid re-querying on writes to OTHER tables.
                const rev = this.revisionGetter?.() ?? '0';

                // Fast path: in-memory revision changed → our CRUD wrote to this table
                const inMemoryChanged = rev !== lastInMemoryRev;
                lastInMemoryRev = rev;

                // Check table-specific fingerprint (COUNT + MAX(id))
                const fpRows = this.executor(fingerprintSQL.sql, fingerprintSQL.params, true);
                const fpRow = fpRows[0] as any;
                const cnt = fpRow?._cnt ?? 0;
                const max = fpRow?._max ?? 0;
                const fpChanged = cnt !== lastCount || max !== lastMax;
                lastCount = cnt;
                lastMax = max;

                // Fire callback only if THIS table actually changed
                if (inMemoryChanged || fpChanged) {
                    const rows = this.all();
                    await callback(rows);
                }
            } catch {
                // Silently skip on error (table might be in transition)
            }
            // Self-scheduling: next poll only after this one completes
            if (!stopped) setTimeout(poll, interval);
        };

        // Immediate first execution
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
     * calls your callback once per new row, in insertion order. The SQL
     * `WHERE id > watermark` is rebuilt each poll with the latest value,
     * so it's always O(new_rows) — not O(table_size).
     *
     * Composes with the query builder chain: any `.where()` conditions
     * are combined with the watermark clause.
     *
     * ```ts
     * // All new messages
     * const unsub = db.messages.select().each((msg) => {
     *     console.log('New:', msg.text);
     * });
     *
     * // Only new messages by Alice
     * const unsub2 = db.messages.select()
     *     .where({ author: 'Alice' })
     *     .each((msg) => console.log(msg.text));
     * ```
     *
     * @param callback  Called once per new row. Async callbacks are awaited.
     * @param options   `interval` in ms (default: pollInterval).
     * @returns Unsubscribe function.
     */
    each(
        callback: (row: T) => void | Promise<void>,
        options: { interval?: number } = {},
    ): () => void {
        const { interval = this.defaultPollInterval } = options;

        // Compile the user's WHERE clause (if any) so we can combine with watermark
        const userWhere = this.buildWhereClause();

        // Initialize watermark to current max id, respecting user's WHERE clause
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

                // Combine user WHERE with watermark: WHERE (user_conditions) AND id > ?
                const params = [...userWhere.params, lastMaxId];
                const whereClause = userWhere.sql
                    ? `WHERE ${userWhere.sql} AND id > ? ORDER BY id ASC`
                    : `WHERE id > ? ORDER BY id ASC`;
                const sql = `SELECT * FROM ${this.tableName} ${whereClause}`;

                // raw=false → rows go through transform + get .update()/.delete() methods
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

    /** Build a lightweight fingerprint query (COUNT + MAX(id)) that shares the same WHERE clause. */
    private buildFingerprintSQL(): { sql: string; params: any[] } {
        const where = this.buildWhereClause();
        const sql = `SELECT COUNT(*) as _cnt, MAX(id) as _max FROM ${this.tableName}${where.sql ? ` WHERE ${where.sql}` : ''}`;
        return { sql, params: where.params };
    }

    // ---------- Thenable (async/await support) ----------

    /**
     * Implementing `.then()` makes the builder a "Thenable".
     * This means you can `await` a query builder directly:
     * ```ts
     * const users = await db.users.select().where({ level: 10 });
     * ```
     */
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
