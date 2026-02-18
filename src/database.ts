/**
 * database.ts — Main Database class for sqlite-zod-orm
 *
 * Slim orchestrator: initializes the schema, creates tables/triggers,
 * and delegates CRUD, entity augmentation, and query building to
 * focused modules.
 */
import { Database as SqliteDatabase } from 'bun:sqlite';
import { z } from 'zod';
import { QueryBuilder, executeProxyQuery, createQueryBuilder, type ProxyQueryResult } from './query';
import type {
    SchemaMap, DatabaseOptions, Relationship, RelationsConfig,
    EntityAccessor, TypedAccessors, TypedNavAccessors, AugmentedEntity, UpdateBuilder,
    ProxyColumns, InferSchema, ChangeEvent,
} from './types';
import { asZodObject } from './types';
import {
    parseRelationsConfig,
    getStorableFields,
    zodTypeToSqlType,
} from './schema';
import { transformFromStorage } from './schema';
import type { DatabaseContext } from './context';
import { buildWhereClause } from './helpers';
import { attachMethods } from './entity';
import {
    insert, update, upsert, deleteEntity,
    getById, getOne, findMany, updateWhere, createUpdateBuilder,
} from './crud';

// =============================================================================
// Database Class
// =============================================================================

type Listener = {
    table: string;
    event: ChangeEvent;
    callback: (row: any) => void | Promise<void>;
};

class _Database<Schemas extends SchemaMap> {
    private db: SqliteDatabase;
    private _reactive: boolean;
    private schemas: Schemas;
    private relationships: Relationship[];
    private options: DatabaseOptions;

    /** Shared context for extracted modules. */
    private _ctx: DatabaseContext;

    /** Registered change listeners. */
    private _listeners: Listener[] = [];

    /** Watermark: last processed change id from _changes table. */
    private _changeWatermark: number = 0;

    /** Global poll timer (single loop for all listeners). */
    private _pollTimer: ReturnType<typeof setInterval> | null = null;

    /** Poll interval in ms. */
    private _pollInterval: number;

    constructor(dbFile: string, schemas: Schemas, options: DatabaseOptions = {}) {
        this.db = new SqliteDatabase(dbFile);
        this.db.run('PRAGMA journal_mode = WAL');
        this.db.run('PRAGMA foreign_keys = ON');
        this.schemas = schemas;
        this.options = options;
        this._reactive = options.reactive !== false; // default true
        this._pollInterval = options.pollInterval ?? 100;
        this.relationships = options.relations ? parseRelationsConfig(options.relations, schemas) : [];

        // Build the context that extracted modules use
        this._ctx = {
            db: this.db,
            schemas: this.schemas as SchemaMap,
            relationships: this.relationships,
            attachMethods: (name, entity) => attachMethods(this._ctx, name, entity),
            buildWhereClause: (conds, prefix) => buildWhereClause(conds, prefix),
        };

        this.initializeTables();
        if (this._reactive) this.initializeChangeTracking();
        this.runMigrations();
        if (options.indexes) this.createIndexes(options.indexes);

        // Create typed entity accessors (db.users, db.posts, etc.)
        for (const entityName of Object.keys(schemas)) {
            const key = entityName as keyof Schemas;
            const accessor: EntityAccessor<Schemas[typeof key]> = {
                insert: (data) => insert(this._ctx, entityName, data),
                update: (idOrData: any, data?: any) => {
                    if (typeof idOrData === 'number') return update(this._ctx, entityName, idOrData, data);
                    return createUpdateBuilder(this._ctx, entityName, idOrData);
                },
                upsert: (conditions, data) => upsert(this._ctx, entityName, data, conditions),
                delete: (id) => deleteEntity(this._ctx, entityName, id),
                select: (...cols: string[]) => createQueryBuilder(this._ctx, entityName, cols),
                on: (event: ChangeEvent, callback: (row: any) => void | Promise<void>) => {
                    return this._registerListener(entityName, event, callback);
                },
                _tableName: entityName,
            };
            (this as any)[key] = accessor;
        }
    }

    // =========================================================================
    // Table Initialization & Migrations
    // =========================================================================

    private initializeTables(): void {
        for (const [entityName, schema] of Object.entries(this.schemas)) {
            const storableFields = getStorableFields(schema);
            const columnDefs = storableFields.map(f => `${f.name} ${zodTypeToSqlType(f.type)}`);
            const constraints: string[] = [];

            const belongsToRels = this.relationships.filter(
                rel => rel.type === 'belongs-to' && rel.from === entityName
            );
            for (const rel of belongsToRels) {
                constraints.push(`FOREIGN KEY (${rel.foreignKey}) REFERENCES ${rel.to}(id) ON DELETE SET NULL`);
            }

            const allCols = columnDefs.join(', ');
            const allConstraints = constraints.length > 0 ? ', ' + constraints.join(', ') : '';
            this.db.run(`CREATE TABLE IF NOT EXISTS ${entityName} (id INTEGER PRIMARY KEY AUTOINCREMENT, ${allCols}${allConstraints})`);
        }
    }

    /**
     * Initialize per-table change tracking using triggers.
     *
     * Creates a `_changes` table that logs every insert/update/delete with
     * the table name, operation, and affected row id. This enables
     * row-level change detection for the `on()` API.
     */
    private initializeChangeTracking(): void {
        this.db.run(`CREATE TABLE IF NOT EXISTS _changes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tbl TEXT NOT NULL,
            op TEXT NOT NULL,
            row_id INTEGER NOT NULL
        )`);

        for (const entityName of Object.keys(this.schemas)) {
            // INSERT trigger — logs NEW.id
            this.db.run(`CREATE TRIGGER IF NOT EXISTS _trg_${entityName}_insert
                AFTER INSERT ON ${entityName}
                BEGIN
                    INSERT INTO _changes (tbl, op, row_id) VALUES ('${entityName}', 'insert', NEW.id);
                END`);

            // UPDATE trigger — logs NEW.id (post-update row)
            this.db.run(`CREATE TRIGGER IF NOT EXISTS _trg_${entityName}_update
                AFTER UPDATE ON ${entityName}
                BEGIN
                    INSERT INTO _changes (tbl, op, row_id) VALUES ('${entityName}', 'update', NEW.id);
                END`);

            // DELETE trigger — logs OLD.id (row that was deleted)
            this.db.run(`CREATE TRIGGER IF NOT EXISTS _trg_${entityName}_delete
                AFTER DELETE ON ${entityName}
                BEGIN
                    INSERT INTO _changes (tbl, op, row_id) VALUES ('${entityName}', 'delete', OLD.id);
                END`);
        }

        // Initialize watermark to current max (skip replaying historical changes)
        const row = this.db.query('SELECT MAX(id) as maxId FROM _changes').get() as any;
        this._changeWatermark = row?.maxId ?? 0;
    }

    private runMigrations(): void {
        for (const [entityName, schema] of Object.entries(this.schemas)) {
            const existingColumns = this.db.query(`PRAGMA table_info(${entityName})`).all() as any[];
            const existingNames = new Set(existingColumns.map(c => c.name));

            const storableFields = getStorableFields(schema);
            for (const field of storableFields) {
                if (!existingNames.has(field.name)) {
                    const sqlType = zodTypeToSqlType(field.type);
                    this.db.run(`ALTER TABLE ${entityName} ADD COLUMN ${field.name} ${sqlType}`);
                }
            }
        }
    }

    private createIndexes(indexes: Record<string, (string | string[])[]>): void {
        for (const [tableName, indexDefs] of Object.entries(indexes)) {
            for (const def of indexDefs) {
                const cols = Array.isArray(def) ? def : [def];
                const idxName = `idx_${tableName}_${cols.join('_')}`;
                this.db.run(`CREATE INDEX IF NOT EXISTS ${idxName} ON ${tableName} (${cols.join(', ')})`);
            }
        }
    }

    // =========================================================================
    // Change Listeners — db.table.on('insert' | 'update' | 'delete', cb)
    // =========================================================================

    private _registerListener(table: string, event: ChangeEvent, callback: (row: any) => void | Promise<void>): () => void {
        if (!this._reactive) {
            throw new Error(
                'Change listeners are disabled. Set { reactive: true } (or omit it) in Database options to enable .on().'
            );
        }

        const listener: Listener = { table, event, callback };
        this._listeners.push(listener);
        this._startPolling();

        return () => {
            const idx = this._listeners.indexOf(listener);
            if (idx >= 0) this._listeners.splice(idx, 1);
            if (this._listeners.length === 0) this._stopPolling();
        };
    }

    private _startPolling(): void {
        if (this._pollTimer) return;
        this._pollTimer = setInterval(() => this._processChanges(), this._pollInterval);
    }

    private _stopPolling(): void {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
    }

    /**
     * Core change dispatch loop.
     *
     * Fast path: checks MAX(id) against watermark first — if equal,
     * there are no new changes and we skip entirely (no row materialization).
     * Only fetches actual change rows when something has changed.
     */
    private _processChanges(): void {
        // Fast path: check if anything changed at all (single scalar, index-only)
        const head = this.db.query('SELECT MAX(id) as m FROM _changes').get() as any;
        const maxId: number = head?.m ?? 0;
        if (maxId <= this._changeWatermark) return;

        const changes = this.db.query(
            'SELECT id, tbl, op, row_id FROM _changes WHERE id > ? ORDER BY id'
        ).all(this._changeWatermark) as { id: number; tbl: string; op: string; row_id: number }[];

        for (const change of changes) {
            const listeners = this._listeners.filter(
                l => l.table === change.tbl && l.event === change.op
            );

            if (listeners.length > 0) {
                if (change.op === 'delete') {
                    // Row is gone — pass just the id
                    const payload = { id: change.row_id };
                    for (const l of listeners) {
                        try { l.callback(payload); } catch { /* listener error */ }
                    }
                } else {
                    // insert or update — re-fetch the current row
                    const row = getById(this._ctx, change.tbl, change.row_id);
                    if (row) {
                        for (const l of listeners) {
                            try { l.callback(row); } catch { /* listener error */ }
                        }
                    }
                }
            }

            this._changeWatermark = change.id;
        }

        // Clean up consumed changes
        this.db.run('DELETE FROM _changes WHERE id <= ?', this._changeWatermark);
    }

    // =========================================================================
    // Transactions
    // =========================================================================

    public transaction<T>(callback: () => T): T {
        try {
            this.db.run('BEGIN TRANSACTION');
            const result = callback();
            this.db.run('COMMIT');
            return result;
        } catch (error) {
            this.db.run('ROLLBACK');
            throw new Error(`Transaction failed: ${(error as Error).message}`);
        }
    }

    // =========================================================================
    // Proxy Query
    // =========================================================================

    /** Proxy callback query for complex SQL-like JOINs */
    public query<T extends Record<string, any> = Record<string, any>>(
        callback: (ctx: { [K in keyof Schemas]: ProxyColumns<InferSchema<Schemas[K]>> }) => ProxyQueryResult
    ): T[] {
        return executeProxyQuery(
            this.schemas,
            callback as any,
            (sql: string, params: any[]) => this.db.query(sql).all(...params) as T[],
        );
    }
}

// =============================================================================
// Public Export
// =============================================================================

const Database = _Database as unknown as new <S extends SchemaMap, const R extends RelationsConfig = {}>(
    dbFile: string, schemas: S, options?: DatabaseOptions<R>
) => _Database<S> & TypedNavAccessors<S, R>;

type Database<S extends SchemaMap, R extends RelationsConfig = {}> = _Database<S> & TypedNavAccessors<S, R>;

export { Database };
export type { Database as DatabaseType };
