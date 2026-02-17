import { z } from 'zod';

// ---------- Internal Query Object (IQO) ----------

type OrderDirection = 'asc' | 'desc';
type WhereOperator = '$gt' | '$gte' | '$lt' | '$lte' | '$ne' | '$in';

interface WhereCondition {
    field: string;
    operator: '=' | '>' | '>=' | '<' | '<=' | '!=' | 'IN';
    value: any;
}

interface IQO {
    selects: string[];
    wheres: WhereCondition[];
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
    const selectClause = iqo.selects.length > 0
        ? iqo.selects.map(s => `${tableName}.${s}`).join(', ')
        : `${tableName}.*`;

    let sql = `SELECT ${selectClause} FROM ${tableName}`;

    // WHERE clause
    if (iqo.wheres.length > 0) {
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
 */
export class QueryBuilder<T extends Record<string, any>> {
    private iqo: IQO;
    private tableName: string;
    private executor: (sql: string, params: any[], raw: boolean) => any[];
    private singleExecutor: (sql: string, params: any[], raw: boolean) => any | null;

    constructor(
        tableName: string,
        executor: (sql: string, params: any[], raw: boolean) => any[],
        singleExecutor: (sql: string, params: any[], raw: boolean) => any | null,
    ) {
        this.tableName = tableName;
        this.executor = executor;
        this.singleExecutor = singleExecutor;
        this.iqo = {
            selects: [],
            wheres: [],
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
     * Add WHERE conditions.
     * Supports direct value matching and operator objects:
     * ```ts
     * .where({ name: 'Alice' })
     * .where({ age: { $gt: 18 } })
     * .where({ status: { $in: ['active', 'pending'] } })
     * ```
     */
    where(criteria: Partial<Record<keyof T & string, any>>): this {
        for (const [key, value] of Object.entries(criteria)) {
            if (typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)) {
                // Operator-style: { $gt: 5 }
                for (const [op, operand] of Object.entries(value)) {
                    const sqlOp = OPERATOR_MAP[op as WhereOperator];
                    if (!sqlOp) throw new Error(`Unsupported query operator: '${op}' on field '${key}'.`);
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
        const iqoCopy = { ...this.iqo, selects: [] };
        // Build a COUNT query
        const params: any[] = [];
        let sql = `SELECT COUNT(*) as count FROM ${this.tableName}`;

        if (iqoCopy.wheres.length > 0) {
            const whereParts: string[] = [];
            for (const w of iqoCopy.wheres) {
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

        // Use executor in raw mode to get count
        const results = this.executor(sql, params, true);
        return (results[0] as any)?.count ?? 0;
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
