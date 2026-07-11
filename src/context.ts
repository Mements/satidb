/**
 * context.ts — Shared context interface for Database internals.
 *
 * Provides a slim interface so extracted modules (crud.ts, entity.ts, etc.)
 * can access the Database's internals without importing the full class.
 */
import type { Database as SqliteDatabase } from "bun:sqlite";
import type {
  SchemaMap,
  Relationship,
  AugmentedEntity,
  TableHooks,
} from "./types";
import type { PendingInsertOperation } from "./conflict";

export interface DatabaseContext {
  /** The raw bun:sqlite Database handle. */
  db: SqliteDatabase;

  /** All registered Zod schemas, keyed by entity name. */
  schemas: SchemaMap;

  /** Parsed relationship descriptors. */
  relationships: Relationship[];

  /** Set of registered read-only view names. */
  viewNames: Set<string>;

  /** Augment a raw row with .update()/.delete()/nav methods + auto-persist proxy. */
  attachMethods<T extends Record<string, any>>(
    entityName: string,
    entity: T,
  ): AugmentedEntity<any>;

  /** Build a WHERE clause from a conditions object. */
  buildWhereClause(
    conditions: Record<string, any>,
    tablePrefix?: string,
  ): { clause: string; values: any[] };

  /** Whether to log SQL to console. */
  debug: boolean;

  /** Whether tables have createdAt/updatedAt columns. */
  timestamps: boolean;

  /** Whether soft deletes are enabled (deletedAt column). */
  softDeletes: boolean;

  /** Lifecycle hooks keyed by table name. */
  hooks: Record<string, TableHooks>;

  /** Computed/virtual getters per table. */
  computed: Record<
    string,
    Record<string, (entity: Record<string, any>) => any>
  >;

  /** Cascade delete config — parent table → list of child tables to auto-delete. */
  cascade: Record<string, string[]>;

  /**
   * Conditional measurement helper — wraps fn with measure-fn when debug is on.
   * When debug is off, executes fn directly with zero overhead.
   */
  _m<T>(label: string, fn: () => T): T;

  /**
   * Get a cached prepared statement. Compiles SQL once, reuses on subsequent calls.
   * Falls back to `db.query(sql)` if the statement was finalized.
   */
  _stmt(sql: string): ReturnType<SqliteDatabase["query"]>;

  /** Register a lazy insert that should be executed before the next ORM operation unless it becomes onConflict(). */
  _registerPendingInsert?(operation: PendingInsertOperation): void;

  /** Remove a lazy insert from the pending queue. */
  _unregisterPendingInsert?(operation: PendingInsertOperation): void;

  /** Execute all pending lazy inserts. */
  _flushPendingInserts?(): void;
}
