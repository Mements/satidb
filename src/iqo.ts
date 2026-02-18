/**
 * iqo.ts — Internal Query Object types and SQL compiler.
 *
 * The IQO is the intermediate representation that the QueryBuilder
 * accumulates via chaining. `compileIQO` turns it into executable SQL.
 */
import { compileAST, type ASTNode } from './ast';

// ---------- Types ----------

export type OrderDirection = 'asc' | 'desc';
export type WhereOperator = '$gt' | '$gte' | '$lt' | '$lte' | '$ne' | '$in';

export interface WhereCondition {
    field: string;
    operator: '=' | '>' | '>=' | '<' | '<=' | '!=' | 'IN';
    value: any;
}

export interface JoinClause {
    table: string;
    fromCol: string;
    toCol: string;
    columns: string[];   // columns to SELECT from the joined table
}

export interface IQO {
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

export const OPERATOR_MAP: Record<WhereOperator, string> = {
    $gt: '>',
    $gte: '>=',
    $lt: '<',
    $lte: '<=',
    $ne: '!=',
    $in: 'IN',
};

// ---------- Helpers ----------

export function transformValueForStorage(value: any): any {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
}

// ---------- SQL Compilation ----------

/**
 * Compile an Internal Query Object into executable SQL + params.
 *
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
