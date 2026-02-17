import { z } from 'zod';
import type { EntityAccessor, InferSchema } from './types';
import {
    type ASTNode, type WhereCallback, type TypedColumnProxy, type FunctionProxy, type Operators,
    compileAST, wrapNode, createColumnProxy, createFunctionProxy, op,
} from './ast';

/** Extract the schema's inferred field keys from an EntityAccessor */
type InferAccessorSchema<A> = A extends EntityAccessor<infer S> ? InferSchema<S> : never;

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
        const whereParts: string[] = [];
        for (const w of iqo.wheres) {
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

    constructor(
        tableName: string,
        executor: (sql: string, params: any[], raw: boolean) => any[],
        singleExecutor: (sql: string, params: any[], raw: boolean) => any | null,
        joinResolver?: ((fromTable: string, toTable: string) => { fk: string; pk: string } | null) | null,
    ) {
        this.tableName = tableName;
        this.executor = executor;
        this.singleExecutor = singleExecutor;
        this.joinResolver = joinResolver ?? null;
        this.iqo = {
            selects: [],
            wheres: [],
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
    where(criteriaOrCallback: Partial<Record<keyof T & string, any>> | WhereCallback<T>): this {
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
            // Object-style: parse into IQO conditions
            for (const [key, value] of Object.entries(criteriaOrCallback)) {
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
    join<A extends EntityAccessor<any>>(
        accessor: A,
        columns?: (keyof InferAccessorSchema<A> & string)[],
    ): this;
    join(
        table: string,
        fk: string,
        columns?: string[],
        pk?: string,
    ): this;
    join(tableOrAccessor: string | EntityAccessor<any>, fkOrCols?: string | string[], colsOrPk?: string[] | string, pk?: string): this {
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

    // ---------- Terminal / Execution Methods ----------

    /** Execute the query and return all matching rows. */
    all(): T[] {
        const { sql, params } = compileIQO(this.tableName, this.iqo);
        return this.executor(sql, params, this.iqo.raw);
    }

    /** Execute the query and return the first matching row, or null. */
    get(): T | null {
        this.iqo.limit = 1;
        const { sql, params } = compileIQO(this.tableName, this.iqo);
        return this.singleExecutor(sql, params, this.iqo.raw);
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
     * Instead of re-fetching all rows every tick, it runs a lightweight
     * fingerprint query (`SELECT COUNT(*), MAX(id)`) with the same WHERE clause.
     * The full query is only re-executed when the fingerprint changes.
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
     * @param callback  Called with the full result set whenever the data changes.
     * @param options   `interval` in ms (default 500). Set `immediate` to false to skip the first call.
     * @returns An unsubscribe function that clears the polling interval.
     */
    subscribe(
        callback: (rows: T[]) => void,
        options: { interval?: number; immediate?: boolean } = {},
    ): () => void {
        const { interval = 500, immediate = true } = options;

        // Build the fingerprint SQL (COUNT + MAX(id)) using the same WHERE
        const fingerprintSQL = this.buildFingerprintSQL();
        let lastFingerprint: string | null = null;

        const poll = () => {
            try {
                // Run lightweight fingerprint check
                const fpRows = this.executor(fingerprintSQL.sql, fingerprintSQL.params, true);
                const fpRow = fpRows[0] as any;
                const currentFingerprint = `${fpRow?._cnt ?? 0}:${fpRow?._max ?? 0}`;

                if (currentFingerprint !== lastFingerprint) {
                    lastFingerprint = currentFingerprint;
                    // Fingerprint changed → re-execute the full query
                    const rows = this.all();
                    callback(rows);
                }
            } catch {
                // Silently skip on error (table might be in transition)
            }
        };

        // Immediate first execution
        if (immediate) {
            poll();
        }

        const timer = setInterval(poll, interval);

        // Return unsubscribe function
        return () => {
            clearInterval(timer);
        };
    }

    /** Build a lightweight fingerprint query (COUNT + MAX(id)) that shares the same WHERE clause. */
    private buildFingerprintSQL(): { sql: string; params: any[] } {
        const params: any[] = [];
        let sql = `SELECT COUNT(*) as _cnt, MAX(id) as _max FROM ${this.tableName}`;

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

        return { sql, params };
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
