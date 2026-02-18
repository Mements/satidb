/**
 * types.ts — All type definitions for sqlite-zod-orm
 *
 * NavEntity<S, R, Table> computes navigation methods from the relations config
 * at the type level — full autocomplete on schema fields AND relationship methods.
 */
import { z } from 'zod';
import type { QueryBuilder } from './query-builder';

export type ZodType = z.ZodTypeAny;
export type SchemaMap = Record<string, z.ZodType<any>>;

/** Relations config: `{ childTable: { fkColumn: 'parentTable' } }` */
export type RelationsConfig = Record<string, Record<string, string>>;

/** Internal cast: all schemas are z.object() at runtime */
export const asZodObject = (s: z.ZodType<any>) => s as unknown as z.ZodObject<any>;

/** Index definition: single column or composite columns */
export type IndexDef = string | string[];

/** Options for the Database constructor */
export type DatabaseOptions<R extends RelationsConfig = RelationsConfig> = {
    indexes?: Record<string, IndexDef[]>;
    /**
     * Declare relationships between tables.
     *
     * Format: `{ childTable: { fkColumn: 'parentTable' } }`
     *
     * `books: { author_id: 'authors' }` → FOREIGN KEY, lazy nav, fluent join.
     */
    relations?: R;
    /**
     * Global polling interval (ms) for `.on()` and `.subscribe()`.
     * Can be overridden per-call. Default: 500ms.
     */
    pollInterval?: number;
};

export type Relationship = {
    type: 'belongs-to' | 'one-to-many';
    from: string;
    to: string;
    relationshipField: string;
    foreignKey: string;
};

// =============================================================================
// Type Helpers
// =============================================================================

export type InferSchema<S extends z.ZodType<any>> = z.infer<S>;
export type InputSchema<S extends z.ZodType<any>> = z.input<S>;
export type EntityData<S extends z.ZodType<any>> = Omit<InputSchema<S>, 'id'>;

// =============================================================================
// Navigation Type Inference (simple approach)
// =============================================================================

/** Strip `_id` suffix: `'author_id'` → `'author'` */
type StripIdSuffix<S extends string> = S extends `${infer Base}_id` ? Base : S;

/**
 * Base entity type with schema fields, id, update(), delete().
 * No nav methods — those are added by NavMethods.
 */
type BaseEntity<S extends z.ZodType<any>> = z.infer<S> & {
    id: number;
    update: (data: Partial<Omit<z.input<S>, 'id'>>) => BaseEntity<S> | null;
    delete: () => void;
};

/**
 * Belongs-to nav methods for a table.
 * `books: { author_id: 'authors' }` → book gets `{ author: () => BaseEntity<AuthorSchema> | null }`
 */
type BelongsToNav<
    S extends SchemaMap,
    R extends RelationsConfig,
    Table extends string,
> = Table extends keyof R
    ? { readonly [FK in Extract<keyof R[Table], string> as StripIdSuffix<FK>]:
        R[Table][FK] extends keyof S
        ? () => BaseEntity<S[R[Table][FK]]> | null
        : never }
    : {};

/**
 * Has-many nav methods for a table.
 * If `books: { author_id: 'authors' }`, then `authors` gets `{ books: () => BaseEntity<BookSchema>[] }`
 *
 * We use key remapping in a mapped type: for each child table in R,
 * check if ParentTable appears in its FK target values.
 */
type HasManyNav<
    S extends SchemaMap,
    R extends RelationsConfig,
    ParentTable extends string,
> = {
        readonly [ChildTable in Extract<keyof R & keyof S, string> as
        _FKTargetsContain<R[ChildTable], ParentTable> extends true ? ChildTable : never
        ]: () => BaseEntity<S[ChildTable]>[];
    };

/** Check if any value in record Rec equals Target */
type _FKTargetsContain<Rec, Target extends string> =
    Target extends Rec[keyof Rec] ? true : false;

// =============================================================================
// NavEntity — Full entity type with nav methods (one level deep)
// =============================================================================

/**
 * A fully typed entity returned from the ORM.
 *
 * Nav methods return BaseEntity (one level deep typing).
 * Calling `book.author()` gives you a typed entity, and calling
 * `.books()` on that result works at runtime, just without
 * the second level of nav method types.
 */
export type NavEntity<
    S extends SchemaMap,
    R extends RelationsConfig,
    Table extends string,
> = BaseEntity<S[Table & keyof S]>
    & BelongsToNav<S, R, Table>
    & HasManyNav<S, R, Table>;

// =============================================================================
// Entity Accessors
// =============================================================================

/** Fluent update builder */
export type UpdateBuilder<T> = {
    where: (conditions: Record<string, any>) => UpdateBuilder<T>;
    exec: () => number;
};

/** Nav-aware entity accessor for a specific table */
export type NavEntityAccessor<
    S extends SchemaMap,
    R extends RelationsConfig,
    Table extends string,
> = {
    insert: (data: Omit<z.input<S[Table & keyof S]>, 'id'>) => NavEntity<S, R, Table>;
    update: ((id: number, data: Partial<Omit<z.input<S[Table & keyof S]>, 'id'>>) => NavEntity<S, R, Table> | null)
    & ((data: Partial<Omit<z.input<S[Table & keyof S]>, 'id'>>) => UpdateBuilder<NavEntity<S, R, Table>>);
    upsert: (conditions?: Partial<z.infer<S[Table & keyof S]>>, data?: Partial<z.infer<S[Table & keyof S]>>) => NavEntity<S, R, Table>;
    delete: (id: number) => void;
    select: (...cols: (keyof z.infer<S[Table & keyof S]> & string)[]) => QueryBuilder<NavEntity<S, R, Table>>;
    /**
     * Stream new rows one at a time, in insertion order.
     * Only emits rows inserted AFTER subscription starts.
     * Callbacks are awaited — strict ordering guaranteed even with async handlers.
     * @returns Unsubscribe function.
     */
    on: (callback: (row: NavEntity<S, R, Table>) => void | Promise<void>, options?: { interval?: number }) => () => void;
    _tableName: string;
    readonly _schema?: S[Table & keyof S];
};

/** Map each table in the schema to its nav-aware accessor */
export type TypedNavAccessors<S extends SchemaMap, R extends RelationsConfig> = {
    [K in Extract<keyof S, string>]: NavEntityAccessor<S, R, K>;
};

// =============================================================================
// Legacy types (used internally by _Database class)
// =============================================================================

export type AugmentedEntity<S extends z.ZodType<any>> = InferSchema<S> & {
    id: number;
    update: (data: Partial<EntityData<S>>) => AugmentedEntity<S> | null;
    delete: () => void;
};

export type EntityAccessor<S extends z.ZodType<any>> = {
    insert: (data: EntityData<S>) => AugmentedEntity<S>;
    update: ((id: number, data: Partial<EntityData<S>>) => AugmentedEntity<S> | null) & ((data: Partial<EntityData<S>>) => UpdateBuilder<AugmentedEntity<S>>);
    upsert: (conditions?: Partial<InferSchema<S>>, data?: Partial<InferSchema<S>>) => AugmentedEntity<S>;
    delete: (id: number) => void;
    select: (...cols: (keyof InferSchema<S> & string)[]) => QueryBuilder<AugmentedEntity<S>>;
    /**
     * Stream new rows one at a time, in insertion order.
     * Only emits rows inserted AFTER subscription starts.
     * Callbacks are awaited — strict ordering guaranteed even with async handlers.
     * @returns Unsubscribe function.
     */
    on: (callback: (row: AugmentedEntity<S>) => void | Promise<void>, options?: { interval?: number }) => () => void;
    _tableName: string;
    readonly _schema?: S;
};

export type TypedAccessors<T extends SchemaMap> = {
    [K in keyof T]: EntityAccessor<T[K]>;
};

// =============================================================================
// Proxy query column types
// =============================================================================

import type { ColumnNode } from './proxy-query';

export type ColumnRef = ColumnNode & string;

export type ProxyColumns<T> = Required<{ [K in keyof T]: ColumnRef }> & {
    id: ColumnRef;
    [k: string]: ColumnRef;
};
