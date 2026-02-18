/**
 * database.ts — Main Database class for sqlite-zod-orm
 *
 * Orchestrates schema-driven table creation, CRUD, relationships,
 * query builders, and event handling.
 */
import { Database as SqliteDatabase } from 'bun:sqlite';
import { z } from 'zod';
import { QueryBuilder } from './query-builder';
import { executeProxyQuery, type ProxyQueryResult } from './proxy-query';
import type {
    SchemaMap, DatabaseOptions, Relationship, RelationsConfig,
    EntityAccessor, TypedAccessors, TypedNavAccessors, AugmentedEntity, UpdateBuilder,
    ProxyColumns, InferSchema,
} from './types';
import { asZodObject } from './types';
import {
    parseRelationsConfig,
    getStorableFields,
    zodTypeToSqlType, transformForStorage, transformFromStorage,
} from './schema';

// =============================================================================
// Database Class
// =============================================================================

class _Database<Schemas extends SchemaMap> {
    private db: SqliteDatabase;
    private schemas: Schemas;
    private relationships: Relationship[];
    private options: DatabaseOptions;
    private pollInterval: number;

    /** In-memory revision counter per table — bumps on every write (insert/update/delete).
     *  Used by QueryBuilder.subscribe() fingerprint to detect ALL changes with zero overhead. */
    private _revisions: Record<string, number> = {};

    constructor(dbFile: string, schemas: Schemas, options: DatabaseOptions = {}) {
        this.db = new SqliteDatabase(dbFile);
        this.db.run('PRAGMA journal_mode = WAL');  // WAL enables concurrent read + write
        this.db.run('PRAGMA foreign_keys = ON');
        this.schemas = schemas;
        this.options = options;
        this.pollInterval = options.pollInterval ?? 500;
        this.relationships = options.relations ? parseRelationsConfig(options.relations, schemas) : [];
        this.initializeTables();
        this.runMigrations();
        if (options.indexes) this.createIndexes(options.indexes);

        // Create typed entity accessors (db.users, db.posts, etc.)
        for (const entityName of Object.keys(schemas)) {
            const key = entityName as keyof Schemas;
            const accessor: EntityAccessor<Schemas[typeof key]> = {
                insert: (data) => this.insert(entityName, data),
                update: (idOrData: any, data?: any) => {
                    if (typeof idOrData === 'number') return this.update(entityName, idOrData, data);
                    return this._createUpdateBuilder(entityName, idOrData);
                },
                upsert: (conditions, data) => this.upsert(entityName, data, conditions),
                delete: (id) => this.delete(entityName, id),
                select: (...cols: string[]) => this._createQueryBuilder(entityName, cols),
                on: (event: string, callback: (row: any) => void | Promise<void>, options?: { interval?: number }) => {
                    if (event === 'insert') return this._createOnStream(entityName, callback, options?.interval);
                    if (event === 'change') return this._createChangeStream(entityName, callback, options?.interval);
                    throw new Error(`Unknown event type: '${event}'. Supported: 'insert', 'change'`);
                },
                _tableName: entityName,
            };
            (this as any)[key] = accessor;
        }
    }

    // ===========================================================================
    // Table Initialization & Migrations
    // ===========================================================================

    private initializeTables(): void {
        for (const [entityName, schema] of Object.entries(this.schemas)) {
            const storableFields = getStorableFields(schema);
            const columnDefs = storableFields.map(f => `${f.name} ${zodTypeToSqlType(f.type)}`);
            const constraints: string[] = [];

            // Add FOREIGN KEY constraints for FK columns declared in the schema
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

    // ===========================================================================
    // Revision Tracking (in-memory + cross-process)
    // ===========================================================================

    /** Bump the revision counter for a table. Called on every write. */
    private _bumpRevision(entityName: string): void {
        this._revisions[entityName] = (this._revisions[entityName] ?? 0) + 1;
    }

    /**
     * Get a composite revision string for a table.
     *
     * Combines two signals:
     *  - In-memory counter: catches writes from THIS process (our CRUD methods bump it)
     *  - PRAGMA data_version: catches writes from OTHER processes (SQLite bumps it
     *    whenever another connection commits, but NOT for the current connection)
     *
     * Together they detect ALL changes regardless of source, with zero disk overhead.
     */
    public _getRevision(entityName: string): string {
        const rev = this._revisions[entityName] ?? 0;
        const dataVersion = (this.db.query('PRAGMA data_version').get() as any)?.data_version ?? 0;
        return `${rev}:${dataVersion}`;
    }

    // ===========================================================================
    // Row Stream — .on(callback)
    // ===========================================================================

    /**
     * Stream new rows one at a time, in insertion order.
     *
     * Uses a watermark (last seen id) to query only `WHERE id > ?`.
     * Checks revision + data_version first to avoid unnecessary queries.
     */
    public _createOnStream(
        entityName: string,
        callback: (row: any) => void | Promise<void>,
        intervalOverride?: number,
    ): () => void {
        const interval = intervalOverride ?? this.pollInterval;

        // Initialize watermark to current max id (only emit NEW rows)
        const maxRow = this.db.query(`SELECT MAX(id) as _max FROM "${entityName}"`).get() as any;
        let lastMaxId: number = maxRow?._max ?? 0;
        let lastRevision: string = this._getRevision(entityName);
        let stopped = false;

        // Self-scheduling async loop: guarantees strict ordering
        // - Each callback (sync or async) completes before the next row is emitted
        // - Next poll only starts after the current batch is fully processed
        const poll = async () => {
            if (stopped) return;

            // Fast check: did anything change?
            const currentRevision = this._getRevision(entityName);
            if (currentRevision !== lastRevision) {
                lastRevision = currentRevision;

                // Fetch new rows since watermark
                const newRows = this.db.query(
                    `SELECT * FROM "${entityName}" WHERE id > ? ORDER BY id ASC`
                ).all(lastMaxId) as any[];

                for (const rawRow of newRows) {
                    if (stopped) return; // bail if unsubscribed mid-batch
                    const entity = this._attachMethods(
                        entityName,
                        transformFromStorage(rawRow, this.schemas[entityName]!)
                    );
                    await callback(entity); // await async callbacks
                    lastMaxId = rawRow.id;
                }
            }

            // Schedule next poll only after this one is done
            if (!stopped) setTimeout(poll, interval);
        };

        // Start the loop
        setTimeout(poll, interval);

        return () => { stopped = true; };
    }

    /**
     * Stream all mutations (insert / update / delete) as ChangeEvent objects.
     *
     * Maintains a full snapshot and diffs on each poll.
     * Heavier than _createOnStream (which only tracks watermark), but catches all changes.
     */
    public _createChangeStream(
        entityName: string,
        callback: (event: any) => void | Promise<void>,
        intervalOverride?: number,
    ): () => void {
        const interval = intervalOverride ?? this.pollInterval;

        // Build initial snapshot: Map<id, serialized row>
        const allRows = this.db.query(`SELECT * FROM "${entityName}" ORDER BY id ASC`).all() as any[];
        let snapshot = new Map<number, string>();
        let snapshotEntities = new Map<number, any>();
        for (const row of allRows) {
            snapshot.set(row.id, JSON.stringify(row));
            snapshotEntities.set(row.id, row);
        }

        let lastRevision: string = this._getRevision(entityName);
        let stopped = false;

        const poll = async () => {
            if (stopped) return;

            const currentRevision = this._getRevision(entityName);
            if (currentRevision !== lastRevision) {
                lastRevision = currentRevision;

                const currentRows = this.db.query(`SELECT * FROM "${entityName}" ORDER BY id ASC`).all() as any[];
                const currentMap = new Map<number, string>();
                const currentEntities = new Map<number, any>();
                for (const row of currentRows) {
                    currentMap.set(row.id, JSON.stringify(row));
                    currentEntities.set(row.id, row);
                }

                // Detect inserts and updates
                for (const [id, json] of currentMap) {
                    if (stopped) return;
                    if (!snapshot.has(id)) {
                        // INSERT
                        const entity = this._attachMethods(
                            entityName,
                            transformFromStorage(currentEntities.get(id), this.schemas[entityName]!)
                        );
                        await callback({ type: 'insert', row: entity });
                    } else if (snapshot.get(id) !== json) {
                        // UPDATE
                        const entity = this._attachMethods(
                            entityName,
                            transformFromStorage(currentEntities.get(id), this.schemas[entityName]!)
                        );
                        const oldEntity = this._attachMethods(
                            entityName,
                            transformFromStorage(snapshotEntities.get(id), this.schemas[entityName]!)
                        );
                        await callback({ type: 'update', row: entity, oldRow: oldEntity });
                    }
                }

                // Detect deletes
                for (const [id] of snapshot) {
                    if (stopped) return;
                    if (!currentMap.has(id)) {
                        const oldEntity = this._attachMethods(
                            entityName,
                            transformFromStorage(snapshotEntities.get(id), this.schemas[entityName]!)
                        );
                        await callback({ type: 'delete', row: oldEntity, oldRow: oldEntity });
                    }
                }

                snapshot = currentMap;
                snapshotEntities = currentEntities;
            }

            if (!stopped) setTimeout(poll, interval);
        };

        setTimeout(poll, interval);

        return () => { stopped = true; };
    }

    // ===========================================================================
    // CRUD
    // ===========================================================================

    private insert<T extends Record<string, any>>(entityName: string, data: Omit<T, 'id'>): AugmentedEntity<any> {
        const schema = this.schemas[entityName]!;
        const validatedData = asZodObject(schema).passthrough().parse(data);
        const transformed = transformForStorage(validatedData);
        const columns = Object.keys(transformed);

        const sql = columns.length === 0
            ? `INSERT INTO ${entityName} DEFAULT VALUES`
            : `INSERT INTO ${entityName} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;

        const result = this.db.query(sql).run(...Object.values(transformed));
        const newEntity = this._getById(entityName, result.lastInsertRowid as number);
        if (!newEntity) throw new Error('Failed to retrieve entity after insertion');

        this._bumpRevision(entityName);
        return newEntity;
    }

    /** Internal: get a single entity by ID */
    private _getById(entityName: string, id: number): AugmentedEntity<any> | null {
        const row = this.db.query(`SELECT * FROM ${entityName} WHERE id = ?`).get(id) as any;
        if (!row) return null;
        return this._attachMethods(entityName, transformFromStorage(row, this.schemas[entityName]!));
    }

    /** Internal: get a single entity by conditions */
    private _getOne(entityName: string, conditions: Record<string, any>): AugmentedEntity<any> | null {
        const { clause, values } = this.buildWhereClause(conditions);
        const row = this.db.query(`SELECT * FROM ${entityName} ${clause} LIMIT 1`).get(...values) as any;
        if (!row) return null;
        return this._attachMethods(entityName, transformFromStorage(row, this.schemas[entityName]!));
    }

    /** Internal: find multiple entities by conditions */
    private _findMany(entityName: string, conditions: Record<string, any> = {}): AugmentedEntity<any>[] {
        const { clause, values } = this.buildWhereClause(conditions);
        const rows = this.db.query(`SELECT * FROM ${entityName} ${clause}`).all(...values);
        return rows.map((row: any) =>
            this._attachMethods(entityName, transformFromStorage(row, this.schemas[entityName]!))
        );
    }

    private update<T extends Record<string, any>>(entityName: string, id: number, data: Partial<Omit<T, 'id'>>): AugmentedEntity<any> | null {
        const schema = this.schemas[entityName]!;
        const validatedData = asZodObject(schema).partial().parse(data);
        const transformed = transformForStorage(validatedData);
        if (Object.keys(transformed).length === 0) return this._getById(entityName, id);

        const setClause = Object.keys(transformed).map(key => `${key} = ?`).join(', ');
        this.db.query(`UPDATE ${entityName} SET ${setClause} WHERE id = ?`).run(...Object.values(transformed), id);

        this._bumpRevision(entityName);
        const updatedEntity = this._getById(entityName, id);
        return updatedEntity;
    }

    private _updateWhere(entityName: string, data: Record<string, any>, conditions: Record<string, any>): number {
        const schema = this.schemas[entityName]!;
        const validatedData = asZodObject(schema).partial().parse(data);
        const transformed = transformForStorage(validatedData);
        if (Object.keys(transformed).length === 0) return 0;

        const { clause, values: whereValues } = this.buildWhereClause(conditions);
        if (!clause) throw new Error('update().where() requires at least one condition');

        const setCols = Object.keys(transformed);
        const setClause = setCols.map(key => `${key} = ?`).join(', ');
        const result = this.db.query(`UPDATE ${entityName} SET ${setClause} ${clause}`).run(
            ...setCols.map(key => transformed[key]),
            ...whereValues
        );

        const affected = (result as any).changes ?? 0;
        if (affected > 0) this._bumpRevision(entityName);
        return affected;
    }

    private _createUpdateBuilder(entityName: string, data: Record<string, any>): UpdateBuilder<any> {
        let _conditions: Record<string, any> = {};
        const builder: UpdateBuilder<any> = {
            where: (conditions) => { _conditions = { ..._conditions, ...conditions }; return builder; },
            exec: () => this._updateWhere(entityName, data, _conditions),
        };
        return builder;
    }

    private upsert<T extends Record<string, any>>(entityName: string, data: any, conditions: any = {}): AugmentedEntity<any> {
        const hasId = data?.id && typeof data.id === 'number';
        const existing = hasId
            ? this._getById(entityName, data.id)
            : Object.keys(conditions ?? {}).length > 0
                ? this._getOne(entityName, conditions)
                : null;

        if (existing) {
            const updateData = { ...data };
            delete updateData.id;
            return this.update(entityName, existing.id, updateData) as AugmentedEntity<any>;
        }
        const insertData = { ...(conditions ?? {}), ...(data ?? {}) };
        delete insertData.id;
        return this.insert(entityName, insertData);
    }

    private delete(entityName: string, id: number): void {
        const entity = this._getById(entityName, id);
        if (entity) {
            this.db.query(`DELETE FROM ${entityName} WHERE id = ?`).run(id);
            this._bumpRevision(entityName);
        }
    }

    // ===========================================================================
    // Entity Methods
    // ===========================================================================

    private _attachMethods<T extends Record<string, any>>(
        entityName: string, entity: T
    ): AugmentedEntity<any> {
        const augmented = entity as any;
        augmented.update = (data: any) => this.update(entityName, entity.id, data);
        augmented.delete = () => this.delete(entityName, entity.id);

        // Attach lazy relationship navigation
        for (const rel of this.relationships) {
            if (rel.from === entityName && rel.type === 'belongs-to') {
                // book.author() → lazy load parent via author_id FK
                augmented[rel.relationshipField] = () => {
                    const fkValue = entity[rel.foreignKey];
                    return fkValue ? this._getById(rel.to, fkValue) : null;
                };
            } else if (rel.from === entityName && rel.type === 'one-to-many') {
                // author.books() → lazy load children
                const belongsToRel = this.relationships.find(
                    r => r.type === 'belongs-to' && r.from === rel.to && r.to === rel.from
                );
                if (belongsToRel) {
                    const fk = belongsToRel.foreignKey;
                    augmented[rel.relationshipField] = () => {
                        return this._findMany(rel.to, { [fk]: entity.id });
                    };
                }
            }
        }

        // Auto-persist proxy: setting a field auto-updates the DB row
        const storableFieldNames = new Set(getStorableFields(this.schemas[entityName]!).map(f => f.name));
        return new Proxy(augmented, {
            set: (target, prop: string, value) => {
                if (storableFieldNames.has(prop) && target[prop] !== value) {
                    this.update(entityName, target.id, { [prop]: value });
                }
                target[prop] = value;
                return true;
            },
            get: (target, prop, receiver) => Reflect.get(target, prop, receiver),
        });
    }

    // ===========================================================================
    // SQL Helpers
    // ===========================================================================

    private buildWhereClause(conditions: Record<string, any>, tablePrefix?: string): { clause: string; values: any[] } {
        const parts: string[] = [];
        const values: any[] = [];

        for (const key in conditions) {
            if (key.startsWith('$')) {
                if (key === '$or' && Array.isArray(conditions[key])) {
                    const orBranches = conditions[key] as Record<string, any>[];
                    const orParts: string[] = [];
                    for (const branch of orBranches) {
                        const sub = this.buildWhereClause(branch, tablePrefix);
                        if (sub.clause) {
                            orParts.push(`(${sub.clause.replace(/^WHERE /, '')})`);
                            values.push(...sub.values);
                        }
                    }
                    if (orParts.length > 0) parts.push(`(${orParts.join(' OR ')})`);
                }
                continue;
            }
            const value = conditions[key];
            const fieldName = tablePrefix ? `${tablePrefix}.${key}` : key;

            if (typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)) {
                const operator = Object.keys(value)[0];
                if (!operator?.startsWith('$')) {
                    throw new Error(`Querying on nested object '${key}' not supported. Use operators like $gt.`);
                }
                const operand = value[operator];

                if (operator === '$in') {
                    if (!Array.isArray(operand)) throw new Error(`$in for '${key}' requires an array`);
                    if (operand.length === 0) { parts.push('1 = 0'); continue; }
                    parts.push(`${fieldName} IN (${operand.map(() => '?').join(', ')})`);
                    values.push(...operand.map((v: any) => transformForStorage({ v }).v));
                    continue;
                }

                const sqlOp = ({ $gt: '>', $gte: '>=', $lt: '<', $lte: '<=', $ne: '!=' } as Record<string, string>)[operator];
                if (!sqlOp) throw new Error(`Unsupported operator '${operator}' on '${key}'`);
                parts.push(`${fieldName} ${sqlOp} ?`);
                values.push(transformForStorage({ operand }).operand);
            } else {
                parts.push(`${fieldName} = ?`);
                values.push(transformForStorage({ value }).value);
            }
        }

        return { clause: parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '', values };
    }

    // ===========================================================================
    // Transactions
    // ===========================================================================

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

    // ===========================================================================
    // Query Builders
    // ===========================================================================

    private _createQueryBuilder(entityName: string, initialCols: string[]): QueryBuilder<any> {
        const schema = this.schemas[entityName]!;

        const executor = (sql: string, params: any[], raw: boolean): any[] => {
            const rows = this.db.query(sql).all(...params);
            if (raw) return rows;
            return rows.map((row: any) => this._attachMethods(entityName, transformFromStorage(row, schema)));
        };

        const singleExecutor = (sql: string, params: any[], raw: boolean): any | null => {
            const results = executor(sql, params, raw);
            return results.length > 0 ? results[0] : null;
        };

        const joinResolver = (fromTable: string, toTable: string): { fk: string; pk: string } | null => {
            const belongsTo = this.relationships.find(
                r => r.type === 'belongs-to' && r.from === fromTable && r.to === toTable
            );
            if (belongsTo) return { fk: belongsTo.foreignKey, pk: 'id' };
            const reverse = this.relationships.find(
                r => r.type === 'belongs-to' && r.from === toTable && r.to === fromTable
            );
            if (reverse) return { fk: 'id', pk: reverse.foreignKey };
            return null;
        };

        // Pass revision getter — allows .subscribe() to detect ALL changes
        const revisionGetter = () => this._getRevision(entityName);

        // Condition resolver: { author: aliceEntity } → { author_id: 1 }
        const conditionResolver = (conditions: Record<string, any>): Record<string, any> => {
            const resolved: Record<string, any> = {};
            for (const [key, value] of Object.entries(conditions)) {
                // Detect entity references: objects with `id` and `delete` (augmented entities)
                if (value && typeof value === 'object' && typeof value.id === 'number' && typeof value.delete === 'function') {
                    // Find a belongs-to relationship: entityName has a FK named `key_id` pointing to another table
                    const fkCol = key + '_id';
                    const rel = this.relationships.find(
                        r => r.type === 'belongs-to' && r.from === entityName && r.foreignKey === fkCol
                    );
                    if (rel) {
                        resolved[fkCol] = value.id;
                    } else {
                        // Fallback: try any relationship that matches the key as the nav name
                        const relByNav = this.relationships.find(
                            r => r.type === 'belongs-to' && r.from === entityName && r.to === key + 's'
                        ) || this.relationships.find(
                            r => r.type === 'belongs-to' && r.from === entityName && r.to === key
                        );
                        if (relByNav) {
                            resolved[relByNav.foreignKey] = value.id;
                        } else {
                            resolved[key] = value; // pass through
                        }
                    }
                } else {
                    resolved[key] = value;
                }
            }
            return resolved;
        };

        // Eager loader: resolves .with('books') → batch load children
        const eagerLoader = (parentTable: string, relation: string, parentIds: number[]): { key: string; groups: Map<number, any[]> } | null => {
            // 1. Try one-to-many: parentTable has-many relation (e.g., authors → books)
            const hasMany = this.relationships.find(
                r => r.type === 'one-to-many' && r.from === parentTable && r.relationshipField === relation
            );
            if (hasMany) {
                // Find the belongs-to FK on the child table
                const belongsTo = this.relationships.find(
                    r => r.type === 'belongs-to' && r.from === hasMany.to && r.to === parentTable
                );
                if (belongsTo) {
                    const fk = belongsTo.foreignKey;
                    const placeholders = parentIds.map(() => '?').join(', ');
                    const childRows = this.db.query(
                        `SELECT * FROM ${hasMany.to} WHERE ${fk} IN (${placeholders})`
                    ).all(...parentIds) as any[];

                    const groups = new Map<number, any[]>();
                    const childSchema = this.schemas[hasMany.to]!;
                    for (const rawRow of childRows) {
                        const entity = this._attachMethods(
                            hasMany.to,
                            transformFromStorage(rawRow, childSchema)
                        );
                        const parentId = rawRow[fk] as number;
                        if (!groups.has(parentId)) groups.set(parentId, []);
                        groups.get(parentId)!.push(entity);
                    }
                    return { key: relation, groups };
                }
            }

            // 2. Try belongs-to: parentTable belongs-to relation (e.g., books → author)
            const belongsTo = this.relationships.find(
                r => r.type === 'belongs-to' && r.from === parentTable && r.relationshipField === relation
            );
            if (belongsTo) {
                // Load parent entities and map by id
                const fkValues = [...new Set(parentIds)];
                // Actually we need FK values from parent rows, not parent IDs
                // This case is trickier — skip for now, belongs-to is already handled by lazy nav
                return null;
            }

            return null;
        };

        const builder = new QueryBuilder(entityName, executor, singleExecutor, joinResolver, conditionResolver, revisionGetter, eagerLoader, this.pollInterval);
        if (initialCols.length > 0) builder.select(...initialCols);
        return builder;
    }

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
