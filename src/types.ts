/**
 * types.ts — All type definitions for sqlite-zod-orm
 */
import { z } from 'zod';
import type { QueryBuilder } from './query-builder';

export type ZodType = z.ZodTypeAny;
export type SchemaMap = Record<string, z.ZodType<any>>;

/** Internal cast: all schemas are z.object() at runtime */
export const asZodObject = (s: z.ZodType<any>) => s as unknown as z.ZodObject<any>;

/** Index definition: single column or composite columns */
export type IndexDef = string | string[];

/** Options for the Database constructor */
export type DatabaseOptions = {
    /** Enable trigger-based change tracking for efficient subscribe polling */
    changeTracking?: boolean;
    /** Index definitions per table: { tableName: ['col1', ['col2', 'col3']] } */
    indexes?: Record<string, IndexDef[]>;
    /**
     * Declare relationships via config — no z.lazy() or interfaces needed.
     *
     * Format: `{ childTable: { fieldName: 'parentTable' } }`
     *
     * Example:
     * ```
     * relations: {
     *   books: { author: 'authors' },   // books has belongs-to author
     *   comments: { post: 'posts' },     // comments has belongs-to post
     * }
     * ```
     *
     * The ORM auto-creates FK columns (authorId), inverse one-to-many, lazy navigation, and entity refs.
     * Can be used alongside z.lazy() — both are supported.
     */
    relations?: Record<string, Record<string, string>>;
};

export type Relationship = {
    type: 'belongs-to' | 'one-to-many';
    from: string;
    to: string;
    relationshipField: string;
    foreignKey: string;
};

// --- Type helpers ---

export type InferSchema<S extends z.ZodType<any>> = z.infer<S>;

/** Input type: fields with .default() become optional */
export type InputSchema<S extends z.ZodType<any>> = z.input<S>;

export type EntityData<S extends z.ZodType<any>> = Omit<InputSchema<S>, 'id'>;

export type AugmentedEntity<S extends z.ZodType<any>> = InferSchema<S> & {
    update: (data: Partial<EntityData<S>>) => AugmentedEntity<S> | null;
    delete: () => void;
    [key: string]: any;
};

/** Fluent update builder: `db.users.update({ level: 10 }).where({ name: 'Alice' }).exec()` */
export type UpdateBuilder<T> = {
    /** Set filter conditions for the update */
    where: (conditions: Record<string, any>) => UpdateBuilder<T>;
    /** Execute the update and return the number of rows affected */
    exec: () => number;
};

export type EntityAccessor<S extends z.ZodType<any>> = {
    insert: (data: EntityData<S>) => AugmentedEntity<S>;
    get: (conditions: number | Partial<InferSchema<S>>) => AugmentedEntity<S> | null;
    find: (conditions?: Partial<InferSchema<S>>) => AugmentedEntity<S>[];
    all: () => AugmentedEntity<S>[];
    update: ((id: number, data: Partial<EntityData<S>>) => AugmentedEntity<S> | null) & ((data: Partial<EntityData<S>>) => UpdateBuilder<AugmentedEntity<S>>);
    upsert: (conditions?: Partial<InferSchema<S>>, data?: Partial<InferSchema<S>>) => AugmentedEntity<S>;
    delete: (id: number) => void;
    subscribe: (event: 'insert' | 'update' | 'delete', callback: (data: AugmentedEntity<S>) => void) => void;
    unsubscribe: (event: 'insert' | 'update' | 'delete', callback: (data: AugmentedEntity<S>) => void) => void;
    select: (...cols: (keyof InferSchema<S> & string)[]) => QueryBuilder<AugmentedEntity<S>>;
    _tableName: string;
    /** Phantom field for carrying schema type info to .join() */
    readonly _schema?: S;
};

export type TypedAccessors<T extends SchemaMap> = {
    [K in keyof T]: EntityAccessor<T[K]>;
};

// --- Proxy query column types ---

import type { ColumnNode } from './proxy-query';

/**
 * ColumnRef is the type exposed to users in proxy query callbacks.
 * `& string` is a brand that lets TS accept column refs as computed property
 * keys in WHERE / orderBy objects, matching the runtime `toString()` behavior.
 */
export type ColumnRef = ColumnNode & string;

/**
 * Full proxy column map for a schema type T.
 * Declared fields get autocomplete; the index signature allows any runtime column
 * (e.g. FK fields like `authorId`) to be accessed without errors.
 */
export type ProxyColumns<T> = Required<{ [K in keyof T]: ColumnRef }> & {
    id: ColumnRef;
    [k: string]: ColumnRef;
};

