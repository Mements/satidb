/**
 * db-context.ts — Shared context interface for Database internals.
 *
 * Provides a slim interface so extracted modules (crud.ts, entity.ts, etc.)
 * can access the Database's internals without importing the full class.
 */
import type { Database as SqliteDatabase } from 'bun:sqlite';
import type { SchemaMap, Relationship, AugmentedEntity } from './types';

export interface DatabaseContext {
    /** The raw bun:sqlite Database handle. */
    db: SqliteDatabase;

    /** All registered Zod schemas, keyed by entity name. */
    schemas: SchemaMap;

    /** Parsed relationship descriptors. */
    relationships: Relationship[];

    /** Augment a raw row with .update()/.delete()/nav methods + auto-persist proxy. */
    attachMethods<T extends Record<string, any>>(entityName: string, entity: T): AugmentedEntity<any>;

    /** Build a WHERE clause from a conditions object. */
    buildWhereClause(conditions: Record<string, any>, tablePrefix?: string): { clause: string; values: any[] };

    /** Bump the in-memory revision counter (same-process fast path). */
    bumpRevision(entityName: string): void;

    /** Get the composite revision string for a table. */
    getRevision(entityName: string): string;

    /** Default poll interval in ms. */
    pollInterval: number;
}
