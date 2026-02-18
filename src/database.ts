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
    ProxyColumns, InferSchema,
} from './types';
import { asZodObject } from './types';
import {
    parseRelationsConfig,
    getStorableFields,
    zodTypeToSqlType,
} from './schema';
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

class _Database<Schemas extends SchemaMap> {
    private db: SqliteDatabase;
    private schemas: Schemas;
    private relationships: Relationship[];
    private options: DatabaseOptions;
    private pollInterval: number;

    /** In-memory revision counter per table — same-process fast path. */
    private _revisions: Record<string, number> = {};

    /** Shared context for extracted modules. */
    private _ctx: DatabaseContext;

    constructor(dbFile: string, schemas: Schemas, options: DatabaseOptions = {}) {
        this.db = new SqliteDatabase(dbFile);
        this.db.run('PRAGMA journal_mode = WAL');
        this.db.run('PRAGMA foreign_keys = ON');
        this.schemas = schemas;
        this.options = options;
        this.pollInterval = options.pollInterval ?? 500;
        this.relationships = options.relations ? parseRelationsConfig(options.relations, schemas) : [];

        // Build the context that extracted modules use
        this._ctx = {
            db: this.db,
            schemas: this.schemas as SchemaMap,
            relationships: this.relationships,
            attachMethods: (name, entity) => attachMethods(this._ctx, name, entity),
            buildWhereClause: (conds, prefix) => buildWhereClause(conds, prefix),
            bumpRevision: (name) => this._bumpRevision(name),
            getRevision: (name) => this._getRevision(name),
            pollInterval: this.pollInterval,
        };

        this.initializeTables();
        this.initializeChangeTracking();
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
     * Creates a `_satidb_changes` table with one row per user table and a monotonic `seq` counter.
     * INSERT/UPDATE/DELETE triggers on each user table auto-increment the seq.
     * This enables table-specific, cross-process change detection.
     */
    private initializeChangeTracking(): void {
        this.db.run(`CREATE TABLE IF NOT EXISTS _satidb_changes (
            tbl TEXT PRIMARY KEY,
            seq INTEGER NOT NULL DEFAULT 0
        )`);

        for (const entityName of Object.keys(this.schemas)) {
            this.db.run(`INSERT OR IGNORE INTO _satidb_changes (tbl, seq) VALUES (?, 0)`, entityName);

            for (const op of ['insert', 'update', 'delete'] as const) {
                const triggerName = `_satidb_${entityName}_${op}`;
                const event = op.toUpperCase();
                this.db.run(`CREATE TRIGGER IF NOT EXISTS ${triggerName}
                    AFTER ${event} ON ${entityName}
                    BEGIN
                        UPDATE _satidb_changes SET seq = seq + 1 WHERE tbl = '${entityName}';
                    END`);
            }
        }
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
    // Revision Tracking
    // =========================================================================

    private _bumpRevision(entityName: string): void {
        this._revisions[entityName] = (this._revisions[entityName] ?? 0) + 1;
    }

    public _getRevision(entityName: string): string {
        const rev = this._revisions[entityName] ?? 0;
        const row = this.db.query('SELECT seq FROM _satidb_changes WHERE tbl = ?').get(entityName) as any;
        const seq = row?.seq ?? 0;
        return `${rev}:${seq}`;
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
