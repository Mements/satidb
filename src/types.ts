/**
 * types.ts — All type definitions for sqlite-zod-orm
 *
 * NavEntity<S, R, Table> computes navigation methods from the relations config
 * at the type level — full autocomplete on schema fields AND relationship methods.
 */
import { z } from 'zod';
import type { QueryBuilder } from './query';

export type ZodType = z.ZodTypeAny;
export type SchemaMap = Record<string, z.ZodType<any>>;

/** Relations config: `{ childTable: { fkColumn: 'parentTable' } }` */
export type RelationsConfig = Record<string, Record<string, string>>;

/** Internal cast: all schemas are z.object() at runtime */
export const asZodObject = (s: z.ZodType<any>) => s as unknown as z.ZodObject<any>;

/** Index definition: single column or composite columns */
export type IndexDef = string | string[];

/** Lifecycle hooks for a single table. */
export type TableHooks = {
    beforeInsert?: (data: Record<string, any>) => Record<string, any> | void;
    afterInsert?: (entity: Record<string, any>) => void;
    beforeUpdate?: (data: Record<string, any>, id: number) => Record<string, any> | void;
    afterUpdate?: (entity: Record<string, any>) => void;
    beforeDelete?: (id: number) => false | void;
    afterDelete?: (id: number) => void;
};

export type DatabaseOptions<R extends RelationsConfig = RelationsConfig> = {
    indexes?: Record<string, IndexDef[]>;
    /**
     * Unique constraints per table. Each entry is an array of column groups.
     * Single column: `{ users: [['email']] }` → UNIQUE INDEX.
     * Compound: `{ users: [['email'], ['name', 'org_id']] }` → two UNIQUE indexes.
     */
    unique?: Record<string, string[][]>;
    /**
     * Declare relationships between tables.
     *
     * Format: `{ childTable: { fkColumn: 'parentTable' } }`
     *
     * `books: { author_id: 'authors' }` → FOREIGN KEY, lazy nav, fluent join.
     */
    relations?: R;
    /**
     * Global polling interval (ms) for `.on()` change listeners.
     * A single poller serves all listeners. Default: 100ms.
     * Ignored if `reactive` is false.
     */
    pollInterval?: number;
    /**
     * Enable trigger-based change tracking for `.on()` listeners.
     * Set to `false` to skip trigger/table creation entirely — calling
     * `.on()` will throw. Default: `true`.
     */
    reactive?: boolean;
    /**
     * Auto-add `createdAt` and `updatedAt` TEXT columns to every table.
     * `createdAt` is set on insert, `updatedAt` on insert + update.
     * Default: `false`.
     */
    timestamps?: boolean;
    /**
     * Enable soft deletes. Adds a `deletedAt` TEXT column to every table.
     * `delete()` sets `deletedAt` instead of removing the row.
     * Use `.withTrashed()` on queries to include soft-deleted rows.
     * Default: `false`.
     */
    softDeletes?: boolean;
    /**
     * Log every SQL query to the console. Useful for debugging.
     * Default: `false`.
     */
    debug?: boolean;
    /**
     * Lifecycle hooks per table. Each hook receives data and can transform it.
     *
     * - `beforeInsert(data)` — called before insert, return modified data or void
     * - `afterInsert(entity)` — called after insert with the persisted entity
     * - `beforeUpdate(data, id)` — called before update, return modified data or void
     * - `afterUpdate(entity)` — called after update with the updated entity
     * - `beforeDelete(id)` — called before delete, return false to cancel
     * - `afterDelete(id)` — called after delete
     */
    hooks?: Record<string, TableHooks>;
    /**
     * Computed/virtual getters per table. Injected on every read.
     * ```ts
     * computed: { users: { fullName: (u) => u.first + ' ' + u.last } }
     * ```
     */
    computed?: Record<string, Record<string, (entity: Record<string, any>) => any>>;
    /**
     * Cascade delete config per table. When a parent is deleted, children are auto-deleted.
     * ```ts
     * cascade: { authors: ['books'] }  // deleting author → deletes their books
     * ```
     */
    cascade?: Record<string, string[]>;
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

/** Fluent delete builder */
export type DeleteBuilder<T> = {
    where: (conditions: Record<string, any>) => DeleteBuilder<T>;
    exec: () => number;
};

/** Nav-aware entity accessor for a specific table */
export type NavEntityAccessor<
    S extends SchemaMap,
    R extends RelationsConfig,
    Table extends string,
> = {
    insert: (data: Omit<z.input<S[Table & keyof S]>, 'id'>) => NavEntity<S, R, Table>;
    insertMany: (rows: Omit<z.input<S[Table & keyof S]>, 'id'>[]) => NavEntity<S, R, Table>[];
    update: ((id: number, data: Partial<Omit<z.input<S[Table & keyof S]>, 'id'>>) => NavEntity<S, R, Table> | null)
    & ((data: Partial<Omit<z.input<S[Table & keyof S]>, 'id'>>) => UpdateBuilder<NavEntity<S, R, Table>>);
    upsert: (conditions?: Partial<z.infer<S[Table & keyof S]>>, data?: Partial<z.infer<S[Table & keyof S]>>) => NavEntity<S, R, Table>;
    upsertMany: (rows: Partial<z.infer<S[Table & keyof S]>>[], conditions?: Partial<z.infer<S[Table & keyof S]>>) => NavEntity<S, R, Table>[];
    findOrCreate: (conditions: Partial<z.infer<S[Table & keyof S]>>, defaults?: Partial<z.infer<S[Table & keyof S]>>) => { entity: NavEntity<S, R, Table>; created: boolean };
    delete: ((id: number) => void) & (() => DeleteBuilder<NavEntity<S, R, Table>>);
    restore: (id: number) => void;
    select: {
        (): QueryBuilder<NavEntity<S, R, Table>>;
        <K extends (keyof z.infer<S[Table & keyof S]> | 'id') & string>(...cols: K[]): QueryBuilder<NavEntity<S, R, Table>, Pick<NavEntity<S, R, Table>, K>>;
    };
    count: () => number;
    on: ((event: 'insert' | 'update', callback: (row: NavEntity<S, R, Table>) => void | Promise<void>) => () => void) &
    ((event: 'delete', callback: (row: { id: number }) => void | Promise<void>) => () => void);
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

export type ChangeEvent = 'insert' | 'update' | 'delete';

export type EntityAccessor<S extends z.ZodType<any>> = {
    insert: (data: EntityData<S>) => AugmentedEntity<S>;
    insertMany: (rows: EntityData<S>[]) => AugmentedEntity<S>[];
    update: ((id: number, data: Partial<EntityData<S>>) => AugmentedEntity<S> | null) & ((data: Partial<EntityData<S>>) => UpdateBuilder<AugmentedEntity<S>>);
    upsert: (conditions?: Partial<InferSchema<S>>, data?: Partial<InferSchema<S>>) => AugmentedEntity<S>;
    upsertMany: (rows: Partial<InferSchema<S>>[], conditions?: Partial<InferSchema<S>>) => AugmentedEntity<S>[];
    findOrCreate: (conditions: Partial<InferSchema<S>>, defaults?: Partial<InferSchema<S>>) => { entity: AugmentedEntity<S>; created: boolean };
    delete: ((id: number) => void) & (() => DeleteBuilder<AugmentedEntity<S>>);
    /** Undo a soft delete by setting deletedAt = null. Requires softDeletes. */
    restore: (id: number) => void;
    select: {
        (): QueryBuilder<AugmentedEntity<S>>;
        <K extends (keyof InferSchema<S> | 'id') & string>(...cols: K[]): QueryBuilder<AugmentedEntity<S>, Pick<AugmentedEntity<S>, K>>;
    };
    count: () => number;
    on: ((event: 'insert' | 'update', callback: (row: AugmentedEntity<S>) => void | Promise<void>) => () => void) &
    ((event: 'delete', callback: (row: { id: number }) => void | Promise<void>) => () => void);
    _tableName: string;
    readonly _schema?: S;
};

export type TypedAccessors<T extends SchemaMap> = {
    [K in keyof T]: EntityAccessor<T[K]>;
};

// =============================================================================
// Proxy query column types
// =============================================================================

import type { ColumnNode } from './query';

export type ColumnRef = ColumnNode & string;

export type ProxyColumns<T> = Required<{ [K in keyof T]: ColumnRef }> & {
    id: ColumnRef;
    [k: string]: ColumnRef;
};
