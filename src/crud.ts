/**
 * crud.ts — CRUD operations extracted from Database class.
 *
 * Each function accepts a `DatabaseContext` so it can access
 * the db handle, schemas, and entity methods without tight coupling.
 */
import type { AugmentedEntity, UpdateBuilder } from './types';
import { asZodObject } from './types';
import { transformForStorage, transformFromStorage } from './schema';
import type { DatabaseContext } from './context';

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export function getById(ctx: DatabaseContext, entityName: string, id: number): AugmentedEntity<any> | null {
    const row = ctx.db.query(`SELECT * FROM ${entityName} WHERE id = ?`).get(id) as any;
    if (!row) return null;
    return ctx.attachMethods(entityName, transformFromStorage(row, ctx.schemas[entityName]!));
}

export function getOne(ctx: DatabaseContext, entityName: string, conditions: Record<string, any>): AugmentedEntity<any> | null {
    const { clause, values } = ctx.buildWhereClause(conditions);
    const row = ctx.db.query(`SELECT * FROM ${entityName} ${clause} LIMIT 1`).get(...values) as any;
    if (!row) return null;
    return ctx.attachMethods(entityName, transformFromStorage(row, ctx.schemas[entityName]!));
}

export function findMany(ctx: DatabaseContext, entityName: string, conditions: Record<string, any> = {}): AugmentedEntity<any>[] {
    const { clause, values } = ctx.buildWhereClause(conditions);
    const rows = ctx.db.query(`SELECT * FROM ${entityName} ${clause}`).all(...values);
    return rows.map((row: any) =>
        ctx.attachMethods(entityName, transformFromStorage(row, ctx.schemas[entityName]!))
    );
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

export function insert<T extends Record<string, any>>(ctx: DatabaseContext, entityName: string, data: Omit<T, 'id'>): AugmentedEntity<any> {
    const schema = ctx.schemas[entityName]!;
    const validatedData = asZodObject(schema).passthrough().parse(data);
    const transformed = transformForStorage(validatedData);
    const columns = Object.keys(transformed);

    const sql = columns.length === 0
        ? `INSERT INTO ${entityName} DEFAULT VALUES`
        : `INSERT INTO ${entityName} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;

    const result = ctx.db.query(sql).run(...Object.values(transformed));
    const newEntity = getById(ctx, entityName, result.lastInsertRowid as number);
    if (!newEntity) throw new Error('Failed to retrieve entity after insertion');

    return newEntity;
}

export function update<T extends Record<string, any>>(ctx: DatabaseContext, entityName: string, id: number, data: Partial<Omit<T, 'id'>>): AugmentedEntity<any> | null {
    const schema = ctx.schemas[entityName]!;
    const validatedData = asZodObject(schema).partial().parse(data);
    const transformed = transformForStorage(validatedData);
    if (Object.keys(transformed).length === 0) return getById(ctx, entityName, id);

    const setClause = Object.keys(transformed).map(key => `${key} = ?`).join(', ');
    ctx.db.query(`UPDATE ${entityName} SET ${setClause} WHERE id = ?`).run(...Object.values(transformed), id);

    return getById(ctx, entityName, id);
}

export function updateWhere(ctx: DatabaseContext, entityName: string, data: Record<string, any>, conditions: Record<string, any>): number {
    const schema = ctx.schemas[entityName]!;
    const validatedData = asZodObject(schema).partial().parse(data);
    const transformed = transformForStorage(validatedData);
    if (Object.keys(transformed).length === 0) return 0;

    const { clause, values: whereValues } = ctx.buildWhereClause(conditions);
    if (!clause) throw new Error('update().where() requires at least one condition');

    const setCols = Object.keys(transformed);
    const setClause = setCols.map(key => `${key} = ?`).join(', ');
    const result = ctx.db.query(`UPDATE ${entityName} SET ${setClause} ${clause}`).run(
        ...setCols.map(key => transformed[key]),
        ...whereValues
    );

    return (result as any).changes ?? 0;
}

export function createUpdateBuilder(ctx: DatabaseContext, entityName: string, data: Record<string, any>): UpdateBuilder<any> {
    let _conditions: Record<string, any> = {};
    const builder: UpdateBuilder<any> = {
        where: (conditions) => { _conditions = { ..._conditions, ...conditions }; return builder; },
        exec: () => updateWhere(ctx, entityName, data, _conditions),
    };
    return builder;
}

export function upsert<T extends Record<string, any>>(ctx: DatabaseContext, entityName: string, data: any, conditions: any = {}): AugmentedEntity<any> {
    const hasId = data?.id && typeof data.id === 'number';
    const existing = hasId
        ? getById(ctx, entityName, data.id)
        : Object.keys(conditions ?? {}).length > 0
            ? getOne(ctx, entityName, conditions)
            : null;

    if (existing) {
        const updateData = { ...data };
        delete updateData.id;
        return update(ctx, entityName, existing.id, updateData) as AugmentedEntity<any>;
    }
    const insertData = { ...(conditions ?? {}), ...(data ?? {}) };
    delete insertData.id;
    return insert(ctx, entityName, insertData);
}

export function deleteEntity(ctx: DatabaseContext, entityName: string, id: number): void {
    const entity = getById(ctx, entityName, id);
    if (entity) {
        ctx.db.query(`DELETE FROM ${entityName} WHERE id = ?`).run(id);
    }
}
