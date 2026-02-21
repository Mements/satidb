/**
 * entity.ts — Entity augmentation logic extracted from Database class.
 *
 * Handles attaching .update(), .delete(), relationship navigation methods,
 * and the auto-persist proxy to raw row objects.
 */
import type { AugmentedEntity, Relationship } from './types';
import { getStorableFields, transformForStorage } from './schema';
import type { DatabaseContext } from './context';
import { getById, findMany, update, deleteEntity } from './crud';

/**
 * Augment a raw entity with:
 * - .update(data) → persist partial update
 * - .delete() → delete from DB
 * - Lazy relationship accessors (author(), books(), etc.)
 * - Auto-persist proxy: `entity.name = 'New'` auto-updates DB
 */
export function attachMethods<T extends Record<string, any>>(
    ctx: DatabaseContext,
    entityName: string,
    entity: T,
): AugmentedEntity<any> {
    const augmented = entity as any;
    augmented.update = (data: any) => update(ctx, entityName, entity.id, data);
    augmented.delete = () => deleteEntity(ctx, entityName, entity.id);

    // Attach lazy relationship navigation
    for (const rel of ctx.relationships) {
        if (rel.from === entityName && rel.type === 'belongs-to') {
            // book.author() → lazy load parent via author_id FK
            augmented[rel.relationshipField] = () => {
                const fkValue = entity[rel.foreignKey];
                return fkValue ? getById(ctx, rel.to, fkValue) : null;
            };
        } else if (rel.from === entityName && rel.type === 'one-to-many') {
            // author.books() → lazy load children
            const belongsToRel = ctx.relationships.find(
                r => r.type === 'belongs-to' && r.from === rel.to && r.to === rel.from
            );
            if (belongsToRel) {
                const fk = belongsToRel.foreignKey;
                augmented[rel.relationshipField] = () => {
                    return findMany(ctx, rel.to, { [fk]: entity.id });
                };
            }
        }
    }

    // Attach computed/virtual getters from context
    const computedGetters = ctx.computed[entityName];
    if (computedGetters) {
        for (const [key, fn] of Object.entries(computedGetters)) {
            Object.defineProperty(augmented, key, {
                get: () => fn(augmented),
                enumerable: true,
                configurable: true,
            });
        }
    }

    // Auto-persist proxy: setting a field auto-updates the DB row
    const storableFieldNames = new Set(getStorableFields(ctx.schemas[entityName]!).map(f => f.name));
    return new Proxy(augmented, {
        set: (target, prop: string, value) => {
            if (storableFieldNames.has(prop) && target[prop] !== value) {
                update(ctx, entityName, target.id, { [prop]: value });
            }
            target[prop] = value;
            return true;
        },
        get: (target, prop, receiver) => Reflect.get(target, prop, receiver),
    });
}
