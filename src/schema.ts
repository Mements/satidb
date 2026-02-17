/**
 * schema.ts — Schema parsing, relationship detection, and DDL helpers
 */
import { z } from 'zod';
import type { SchemaMap, ZodType, Relationship } from './types';
import { asZodObject } from './types';

/** Parse z.lazy() fields to detect belongs-to and one-to-many relationships */
export function parseRelationships(schemas: SchemaMap): Relationship[] {
    const relationships: Relationship[] = [];

    for (const [entityName, schema] of Object.entries(schemas)) {
        const shape = asZodObject(schema).shape as Record<string, ZodType>;

        for (const [fieldName, fieldSchema] of Object.entries(shape)) {
            let actualSchema = fieldSchema;
            if (actualSchema instanceof z.ZodOptional) {
                actualSchema = actualSchema._def.innerType;
            }

            if (actualSchema instanceof z.ZodLazy) {
                const lazySchema = actualSchema._def.getter();
                let relType: 'belongs-to' | 'one-to-many' | null = null;
                let targetSchema: z.ZodObject<any> | null = null;

                if (lazySchema instanceof z.ZodArray) {
                    relType = 'one-to-many';
                    targetSchema = lazySchema._def.type;
                } else {
                    relType = 'belongs-to';
                    targetSchema = lazySchema;
                }

                if (relType && targetSchema) {
                    const targetEntityName = Object.keys(schemas).find(
                        name => schemas[name] === targetSchema
                    );
                    if (targetEntityName) {
                        const foreignKey = relType === 'belongs-to' ? `${fieldName}Id` : '';
                        relationships.push({
                            type: relType,
                            from: entityName,
                            to: targetEntityName,
                            relationshipField: fieldName,
                            foreignKey,
                        });
                    }
                }
            }
        }
    }

    return relationships;
}

/**
 * Parse declarative `relations` config into Relationship[] objects.
 *
 * Config format: `{ childTable: { fieldName: 'parentTable' } }`
 * Example: `{ books: { author: 'authors' } }` produces:
 *   - books → authors  (belongs-to, FK = authorId)
 *   - authors → books  (one-to-many, inverse, field = 'books')
 */
export function parseRelationsConfig(
    relations: Record<string, Record<string, string>>,
    schemas: SchemaMap,
): Relationship[] {
    const relationships: Relationship[] = [];
    const added = new Set<string>();

    for (const [fromTable, rels] of Object.entries(relations)) {
        if (!schemas[fromTable]) {
            throw new Error(`relations: unknown table '${fromTable}'`);
        }
        for (const [fieldName, toTable] of Object.entries(rels)) {
            if (!schemas[toTable]) {
                throw new Error(`relations: unknown target table '${toTable}' in ${fromTable}.${fieldName}`);
            }

            // belongs-to: books.author → authors
            const btKey = `${fromTable}.${fieldName}:belongs-to`;
            if (!added.has(btKey)) {
                relationships.push({
                    type: 'belongs-to',
                    from: fromTable,
                    to: toTable,
                    relationshipField: fieldName,
                    foreignKey: `${fieldName}Id`,
                });
                added.add(btKey);
            }

            // auto-infer one-to-many inverse: authors.books → books[]
            const otmKey = `${toTable}.${fromTable}:one-to-many`;
            if (!added.has(otmKey)) {
                relationships.push({
                    type: 'one-to-many',
                    from: toTable,
                    to: fromTable,
                    relationshipField: fromTable, // e.g. 'books'
                    foreignKey: '',
                });
                added.add(otmKey);
            }
        }
    }

    return relationships;
}

/** Check if a schema field is a z.lazy() relationship */
export function isRelationshipField(schema: z.ZodType<any>, key: string): boolean {
    let fieldSchema = asZodObject(schema).shape[key];
    if (fieldSchema instanceof z.ZodOptional) {
        fieldSchema = fieldSchema._def.innerType;
    }
    return fieldSchema instanceof z.ZodLazy;
}

/**
 * Check if a field is a relationship based on the relationships array.
 * Used for config-based relations where the field doesn't exist in the schema.
 */
export function isRelationshipFieldByConfig(
    entityName: string,
    key: string,
    relationships: Relationship[],
): boolean {
    return relationships.some(
        r => r.from === entityName && r.type === 'belongs-to' && r.relationshipField === key
    );
}

/** Get storable (non-relationship, non-id) fields from a schema */
export function getStorableFields(schema: z.ZodType<any>): { name: string; type: ZodType }[] {
    return Object.entries(asZodObject(schema).shape)
        .filter(([key]) => key !== 'id' && !isRelationshipField(schema, key))
        .map(([name, type]) => ({ name, type: type as ZodType }));
}

/** Map a Zod type to its SQLite column type */
export function zodTypeToSqlType(zodType: ZodType): string {
    if (zodType instanceof z.ZodOptional) {
        zodType = zodType._def.innerType;
    }
    if (zodType instanceof z.ZodDefault) {
        zodType = zodType._def.innerType;
    }
    if (zodType instanceof z.ZodString || zodType instanceof z.ZodDate) return 'TEXT';
    if (zodType instanceof z.ZodNumber || zodType instanceof z.ZodBoolean) return 'INTEGER';
    if ((zodType as any)._def.typeName === 'ZodInstanceOf' && (zodType as any)._def.type === Buffer) return 'BLOB';
    return 'TEXT';
}

/** Transform JS values to SQLite storage format */
export function transformForStorage(data: Record<string, any>): Record<string, any> {
    const transformed: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
        if (value instanceof Date) {
            transformed[key] = value.toISOString();
        } else if (typeof value === 'boolean') {
            transformed[key] = value ? 1 : 0;
        } else {
            transformed[key] = value;
        }
    }
    return transformed;
}

/** Transform SQLite row back to JS types based on schema */
export function transformFromStorage(row: Record<string, any>, schema: z.ZodType<any>): Record<string, any> {
    const transformed: Record<string, any> = {};
    for (const [key, value] of Object.entries(row)) {
        let fieldSchema = asZodObject(schema).shape[key];
        if (fieldSchema instanceof z.ZodOptional) {
            fieldSchema = fieldSchema._def.innerType;
        }
        if (fieldSchema instanceof z.ZodDefault) {
            fieldSchema = fieldSchema._def.innerType;
        }
        if (fieldSchema instanceof z.ZodDate && typeof value === 'string') {
            transformed[key] = new Date(value);
        } else if (fieldSchema instanceof z.ZodBoolean && typeof value === 'number') {
            transformed[key] = value === 1;
        } else {
            transformed[key] = value;
        }
    }
    return transformed;
}

/** Strip z.lazy() fields from data, converting relationship objects to FK IDs */
export function preprocessRelationshipFields(schema: z.ZodType<any>, data: Record<string, any>): Record<string, any> {
    const processedData = { ...data };
    for (const [key, value] of Object.entries(data)) {
        if (isRelationshipField(schema, key)) {
            if (value && typeof value === 'object' && 'id' in value) {
                processedData[`${key}Id`] = value.id;
                delete processedData[key];
            } else if (typeof value === 'string') {
                processedData[`${key}Id`] = value;
                delete processedData[key];
            }
        }
    }
    return processedData;
}

/**
 * Preprocess relationship fields using the relationships array (config-based).
 * Converts entity references to FK values, e.g. { author: tolstoy } → { authorId: 1 }
 */
export function preprocessRelationshipFieldsByConfig(
    entityName: string,
    data: Record<string, any>,
    relationships: Relationship[],
): Record<string, any> {
    const processedData = { ...data };
    for (const [key, value] of Object.entries(data)) {
        if (isRelationshipFieldByConfig(entityName, key, relationships)) {
            if (value && typeof value === 'object' && 'id' in value) {
                processedData[`${key}Id`] = value.id;
                delete processedData[key];
            } else if (typeof value === 'number') {
                processedData[`${key}Id`] = value;
                delete processedData[key];
            }
        }
    }
    return processedData;
}

