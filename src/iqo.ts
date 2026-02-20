/**
 * iqo.ts — Internal Query Object types and SQL compiler
 *
 * Defines the IQO structure, WHERE operators, and the `compileIQO` function
 * that transforms an IQO into executable SQL + params.
 */

import { type ASTNode, compileAST } from './ast';

// =============================================================================
// IQO — Internal Query Object
// =============================================================================

export type OrderDirection = 'asc' | 'desc';
export type WhereOperator = '$gt' | '$gte' | '$lt' | '$lte' | '$ne' | '$in' | '$like' | '$notIn' | '$between' | '$isNull' | '$isNotNull';

export interface WhereCondition {
    field: string;
    operator: '=' | '>' | '>=' | '<' | '<=' | '!=' | 'IN' | 'LIKE' | 'NOT IN' | 'BETWEEN' | 'IS NULL' | 'IS NOT NULL';
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
    groupBy: string[];
    having: WhereCondition[];
    limit: number | null;
    offset: number | null;
    orderBy: { field: string; direction: OrderDirection }[];
    includes: string[];
    raw: boolean;
    distinct: boolean;
}

export const OPERATOR_MAP: Record<WhereOperator, string> = {
    $gt: '>',
    $gte: '>=',
    $lt: '<',
    $lte: '<=',
    $ne: '!=',
    $in: 'IN',
    $like: 'LIKE',
    $notIn: 'NOT IN',
    $between: 'BETWEEN',
    $isNull: 'IS NULL',
    $isNotNull: 'IS NOT NULL',
};

export function transformValueForStorage(value: any): any {
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

    let sql = `SELECT ${iqo.distinct ? 'DISTINCT ' : ''}${selectParts.join(', ')} FROM ${tableName}`;

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
            } else if (w.operator === 'NOT IN') {
                const arr = w.value as any[];
                if (arr.length === 0) continue; // no-op
                const placeholders = arr.map(() => '?').join(', ');
                whereParts.push(`${qualify(w.field)} NOT IN (${placeholders})`);
                params.push(...arr.map(transformValueForStorage));
            } else if (w.operator === 'BETWEEN') {
                const [min, max] = w.value as [any, any];
                whereParts.push(`${qualify(w.field)} BETWEEN ? AND ?`);
                params.push(transformValueForStorage(min), transformValueForStorage(max));
            } else if (w.operator === 'IS NULL') {
                whereParts.push(`${qualify(w.field)} IS NULL`);
            } else if (w.operator === 'IS NOT NULL') {
                whereParts.push(`${qualify(w.field)} IS NOT NULL`);
            } else {
                whereParts.push(`${qualify(w.field)} ${w.operator} ?`);
                params.push(transformValueForStorage(w.value));
            }
        }
        if (whereParts.length > 0) {
            sql += ` WHERE ${whereParts.join(' AND ')}`;
        }
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

    // GROUP BY
    if (iqo.groupBy.length > 0) {
        sql += ` GROUP BY ${iqo.groupBy.join(', ')}`;
    }

    // HAVING
    if (iqo.having && iqo.having.length > 0) {
        const havingParts: string[] = [];
        for (const h of iqo.having) {
            if (h.operator === 'IS NULL') {
                havingParts.push(`${h.field} IS NULL`);
            } else if (h.operator === 'IS NOT NULL') {
                havingParts.push(`${h.field} IS NOT NULL`);
            } else {
                havingParts.push(`${h.field} ${h.operator} ?`);
                params.push(transformValueForStorage(h.value));
            }
        }
        if (havingParts.length > 0) {
            sql += ` HAVING ${havingParts.join(' AND ')}`;
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
