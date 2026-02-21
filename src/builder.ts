/**
 * builder.ts — Fluent QueryBuilder class
 *
 * Accumulates query state via chaining and executes when a
 * terminal method (.all(), .get(), .count()) is called.
 */

import {
    type ASTNode, type WhereCallback, type TypedColumnProxy, type FunctionProxy, type Operators,
    createColumnProxy, createFunctionProxy, op,
} from './ast';
import {
    type IQO, type WhereCondition, type WhereOperator, type OrderDirection,
    OPERATOR_MAP, compileIQO,
} from './iqo';

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
export class QueryBuilder<T extends Record<string, any>, TResult extends Record<string, any> = T> {
    private iqo: IQO;
    private tableName: string;
    private executor: (sql: string, params: any[], raw: boolean) => any[];
    private singleExecutor: (sql: string, params: any[], raw: boolean) => any | null;
    private joinResolver: ((fromTable: string, toTable: string) => { fk: string; pk: string } | null) | null;
    private conditionResolver: ((conditions: Record<string, any>) => Record<string, any>) | null;
    private eagerLoader: ((parentTable: string, relation: string, parentIds: number[]) => { key: string; groups: Map<number, any[]> } | null) | null;

    constructor(
        tableName: string,
        executor: (sql: string, params: any[], raw: boolean) => any[],
        singleExecutor: (sql: string, params: any[], raw: boolean) => any | null,
        joinResolver?: ((fromTable: string, toTable: string) => { fk: string; pk: string } | null) | null,
        conditionResolver?: ((conditions: Record<string, any>) => Record<string, any>) | null,
        eagerLoader?: ((parentTable: string, relation: string, parentIds: number[]) => { key: string; groups: Map<number, any[]> } | null) | null,
    ) {
        this.tableName = tableName;
        this.executor = executor;
        this.singleExecutor = singleExecutor;
        this.joinResolver = joinResolver ?? null;
        this.conditionResolver = conditionResolver ?? null;
        this.eagerLoader = eagerLoader ?? null;
        this.iqo = {
            selects: [],
            wheres: [],
            whereOrs: [],
            rawWheres: [],
            whereAST: null,
            joins: [],
            groupBy: [],
            having: [],
            limit: null,
            offset: null,
            orderBy: [],
            includes: [],
            raw: false,
            distinct: false,
        };
    }

    /** Specify which columns to select. If called with no arguments, defaults to `*`. */
    select(): this;
    select<K extends keyof T & string>(...cols: K[]): QueryBuilder<T, Pick<T, K>>;
    select(...cols: string[]): any {
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
                        if (opKey === '$between') {
                            if (!Array.isArray(operand) || operand.length !== 2) throw new Error(`$between for '${key}' requires [min, max]`);
                        }
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
     * Add a raw SQL WHERE fragment with parameterized values.
     * Can be combined with `.where()` — fragments are AND'd together.
     *
     * ```ts
     * db.users.select().whereRaw('score > ? AND role != ?', [50, 'guest']).all()
     * ```
     */
    whereRaw(sql: string, params: any[] = []): this {
        this.iqo.rawWheres.push({ sql, params });
        return this;
    }

    /**
     * Filter by column value being in a list or subquery.
     * ```ts
     * db.users.select().whereIn('id', [1, 2, 3]).all()
     * db.users.select().whereIn('id', db.orders.select('userId')).all()
     * ```
     */
    whereIn(column: keyof T & string, values: any[] | QueryBuilder<any, any>): this {
        if (Array.isArray(values)) {
            const placeholders = values.map(() => '?').join(', ');
            this.iqo.rawWheres.push({ sql: `"${column}" IN (${placeholders})`, params: values });
        } else {
            // Subquery: compile the inner QueryBuilder's IQO
            const inner = compileIQO((values as any).tableName, (values as any).iqo);
            this.iqo.rawWheres.push({ sql: `"${column}" IN (${inner.sql})`, params: inner.params });
        }
        return this;
    }

    /**
     * Filter by column value NOT being in a list or subquery.
     */
    whereNotIn(column: keyof T & string, values: any[] | QueryBuilder<any, any>): this {
        if (Array.isArray(values)) {
            const placeholders = values.map(() => '?').join(', ');
            this.iqo.rawWheres.push({ sql: `"${column}" NOT IN (${placeholders})`, params: values });
        } else {
            const inner = compileIQO((values as any).tableName, (values as any).iqo);
            this.iqo.rawWheres.push({ sql: `"${column}" NOT IN (${inner.sql})`, params: inner.params });
        }
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
    all(): TResult[] {
        const { sql, params } = compileIQO(this.tableName, this.iqo);
        const results = this.executor(sql, params, this.iqo.raw);
        return this._applyEagerLoads(results) as unknown as TResult[];
    }

    /** Execute the query and return the first matching row, or null. */
    get(): TResult | null {
        this.iqo.limit = 1;
        const { sql, params } = compileIQO(this.tableName, this.iqo);
        const result = this.singleExecutor(sql, params, this.iqo.raw);
        if (!result) return null;
        const [loaded] = this._applyEagerLoads([result]);
        return (loaded ?? null) as TResult | null;
    }

    /** Execute the query and return the count of matching rows. */
    count(): number {
        // Reuse compileIQO to avoid duplicating WHERE logic
        const { sql: selectSql, params } = compileIQO(this.tableName, this.iqo);
        // Replace "SELECT ... FROM" with "SELECT COUNT(*) as count FROM"
        const countSql = selectSql.replace(/^SELECT .+? FROM/, 'SELECT COUNT(*) as count FROM');
        const results = this.executor(countSql, params, true);
        return (results[0] as any)?.count ?? 0;
    }

    /** Alias for get() — returns the first matching row or null. */
    first(): TResult | null {
        return this.get();
    }

    /** Returns true if at least one row matches the query. */
    exists(): boolean {
        const { sql: selectSql, params } = compileIQO(this.tableName, this.iqo);
        const existsSql = selectSql.replace(/^SELECT .+? FROM/, 'SELECT 1 FROM').replace(/ LIMIT \d+/, '') + ' LIMIT 1';
        const results = this.executor(existsSql, params, true);
        return results.length > 0;
    }

    /** Group results by one or more columns. */
    groupBy(...fields: string[]): this {
        this.iqo.groupBy.push(...fields);
        return this;
    }

    /** Return only distinct rows. */
    distinct(): this {
        this.iqo.distinct = true;
        return this;
    }

    /**
     * Include soft-deleted rows in query results.
     * Only relevant when `softDeletes: true` is set in Database options.
     */
    withTrashed(): this {
        // Remove the auto-injected `deletedAt IS NULL` filter
        this.iqo.wheres = this.iqo.wheres.filter(
            w => !(w.field === 'deletedAt' && w.operator === 'IS NULL')
        );
        return this;
    }

    /**
     * Return only soft-deleted rows.
     * Only relevant when `softDeletes: true` is set in Database options.
     */
    onlyTrashed(): this {
        // Remove the auto-injected `deletedAt IS NULL` and add `deletedAt IS NOT NULL`
        this.iqo.wheres = this.iqo.wheres.filter(
            w => !(w.field === 'deletedAt' && w.operator === 'IS NULL')
        );
        this.iqo.wheres.push({ field: 'deletedAt', operator: 'IS NOT NULL', value: null });
        return this;
    }

    /**
     * Add HAVING conditions (used after groupBy for aggregate filtering).
     *
     * ```ts
     * db.orders.select('user_id').groupBy('user_id')
     *   .having({ 'COUNT(*)': { $gt: 5 } })
     *   .raw().all()
     * ```
     */
    having(conditions: Record<string, any>): this {
        for (const [field, value] of Object.entries(conditions)) {
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                for (const [opKey, operand] of Object.entries(value)) {
                    const sqlOp = OPERATOR_MAP[opKey as WhereOperator];
                    if (!sqlOp) throw new Error(`Unsupported having operator: '${opKey}'`);
                    this.iqo.having.push({ field, operator: sqlOp as WhereCondition['operator'], value: operand });
                }
            } else {
                this.iqo.having.push({ field, operator: '=', value });
            }
        }
        return this;
    }

    // ---------- Aggregate Methods ----------

    /** Returns the SUM of a numeric column. */
    sum(field: keyof T & string): number {
        const { sql: selectSql, params } = compileIQO(this.tableName, this.iqo);
        const aggSql = selectSql.replace(/^SELECT .+? FROM/, `SELECT COALESCE(SUM("${field}"), 0) as val FROM`);
        const results = this.executor(aggSql, params, true);
        return (results[0] as any)?.val ?? 0;
    }

    /** Returns the AVG of a numeric column. */
    avg(field: keyof T & string): number {
        const { sql: selectSql, params } = compileIQO(this.tableName, this.iqo);
        const aggSql = selectSql.replace(/^SELECT .+? FROM/, `SELECT AVG("${field}") as val FROM`);
        const results = this.executor(aggSql, params, true);
        return (results[0] as any)?.val ?? 0;
    }

    /** Returns the MIN of a column. */
    min(field: keyof T & string): number | string | null {
        const { sql: selectSql, params } = compileIQO(this.tableName, this.iqo);
        const aggSql = selectSql.replace(/^SELECT .+? FROM/, `SELECT MIN("${field}") as val FROM`);
        const results = this.executor(aggSql, params, true);
        return (results[0] as any)?.val ?? null;
    }

    /** Returns the MAX of a column. */
    max(field: keyof T & string): number | string | null {
        const { sql: selectSql, params } = compileIQO(this.tableName, this.iqo);
        const aggSql = selectSql.replace(/^SELECT .+? FROM/, `SELECT MAX("${field}") as val FROM`);
        const results = this.executor(aggSql, params, true);
        return (results[0] as any)?.val ?? null;
    }

    /** Paginate results. Returns { data, total, page, perPage, pages }. */
    paginate(page: number = 1, perPage: number = 20): { data: TResult[]; total: number; page: number; perPage: number; pages: number } {
        const total = this.count();
        const pages = Math.ceil(total / perPage);
        this.iqo.limit = perPage;
        this.iqo.offset = (page - 1) * perPage;
        const data = this.all();
        return { data, total, page, perPage, pages };
    }

    /**
     * Count rows per group. Must call `.groupBy()` first.
     * Returns an array of objects with the grouped column(s) and a `count` field.
     *
     * ```ts
     * db.users.select('role').groupBy('role').countGrouped()
     * // → [{ role: 'admin', count: 5 }, { role: 'member', count: 12 }]
     * ```
     */
    countGrouped(): (Record<string, any> & { count: number })[] {
        if (this.iqo.groupBy.length === 0) {
            throw new Error('countGrouped() requires at least one groupBy() call');
        }
        const groupCols = this.iqo.groupBy.map(c => `"${c}"`).join(', ');
        const { sql: selectSql, params } = compileIQO(this.tableName, this.iqo);
        const aggSql = selectSql.replace(
            /^SELECT .+? FROM/,
            `SELECT ${groupCols}, COUNT(*) as count FROM`
        );
        return this.executor(aggSql, params, true) as any;
    }

    // ---------- Batch Mutations ----------

    /**
     * Update all rows matching the current query's WHERE conditions.
     * Returns the number of affected rows.
     * ```ts
     * db.users.select().where({ role: 'guest' }).updateAll({ role: 'member' })
     * ```
     */
    updateAll(data: Partial<T>): number {
        const { sql: selectSql, params } = compileIQO(this.tableName, this.iqo);
        // Extract WHERE clause from compiled SELECT
        const whereMatch = selectSql.match(/WHERE (.+?)(?:\s+ORDER|\s+LIMIT|\s+GROUP|\s+HAVING|$)/s);
        const wherePart = whereMatch ? whereMatch[1] : '1=1';

        const setClauses: string[] = [];
        const setParams: any[] = [];
        for (const [col, val] of Object.entries(data)) {
            setClauses.push(`"${col}" = ?`);
            if (val !== null && val !== undefined && typeof val === 'object' && !(val instanceof Buffer) && !(val instanceof Date)) {
                setParams.push(JSON.stringify(val));
            } else {
                setParams.push(val);
            }
        }

        const updateSql = `UPDATE "${this.tableName}" SET ${setClauses.join(', ')} WHERE ${wherePart}`;
        this.executor(updateSql, [...setParams, ...params], true);
        // Return affected rows via changes()
        const result = this.executor(`SELECT changes() as c`, [], true);
        return (result[0] as any)?.c ?? 0;
    }

    /**
     * Delete all rows matching the current query's WHERE conditions.
     * Returns the number of deleted rows.
     * ```ts
     * db.users.select().where({ role: 'guest' }).deleteAll()
     * ```
     */
    deleteAll(): number {
        const { sql: selectSql, params } = compileIQO(this.tableName, this.iqo);
        const whereMatch = selectSql.match(/WHERE (.+?)(?:\s+ORDER|\s+LIMIT|\s+GROUP|\s+HAVING|$)/s);
        const wherePart = whereMatch ? whereMatch[1] : '1=1';

        const deleteSql = `DELETE FROM "${this.tableName}" WHERE ${wherePart}`;
        this.executor(deleteSql, params, true);
        const result = this.executor(`SELECT changes() as c`, [], true);
        return (result[0] as any)?.c ?? 0;
    }


    // ---------- Thenable (async/await support) ----------

    then<TThen1 = TResult[], TThen2 = never>(
        onfulfilled?: ((value: TResult[]) => TThen1 | PromiseLike<TThen1>) | null,
        onrejected?: ((reason: any) => TThen2 | PromiseLike<TThen2>) | null,
    ): Promise<TThen1 | TThen2> {
        try {
            const result = this.all();
            return Promise.resolve(result).then(onfulfilled, onrejected);
        } catch (err) {
            return Promise.reject(err).then(onfulfilled, onrejected);
        }
    }
}
