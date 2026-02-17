/**
 * database.ts — Main Database class for sqlite-zod-orm
 *
 * Orchestrates schema-driven table creation, CRUD, relationships,
 * query builders, and event handling.
 */
import { Database as SqliteDatabase } from 'bun:sqlite';
import { EventEmitter } from 'events';
import { z } from 'zod';
import { QueryBuilder } from './query-builder';
import { executeProxyQuery, type ProxyQueryResult } from './proxy-query';
import type {
    SchemaMap, DatabaseOptions, Relationship,
    EntityAccessor, TypedAccessors, AugmentedEntity, UpdateBuilder,
    ProxyColumns, InferSchema,
} from './types';
import { asZodObject } from './types';
import {
    parseRelationships, isRelationshipField, getStorableFields,
    zodTypeToSqlType, transformForStorage, transformFromStorage,
    preprocessRelationshipFields,
} from './schema';

// =============================================================================
// Database Class
// =============================================================================

class _Database<Schemas extends SchemaMap> extends EventEmitter {
    private db: SqliteDatabase;
    private schemas: Schemas;
    private relationships: Relationship[];
    private subscriptions: Record<'insert' | 'update' | 'delete', Record<string, ((data: any) => void)[]>>;
    private options: DatabaseOptions;

    constructor(dbFile: string, schemas: Schemas, options: DatabaseOptions = {}) {
        super();
        this.db = new SqliteDatabase(dbFile);
        this.db.run('PRAGMA foreign_keys = ON');
        this.schemas = schemas;
        this.options = options;
        this.subscriptions = { insert: {}, update: {}, delete: {} };
        this.relationships = parseRelationships(schemas);
        this.initializeTables();
        this.runMigrations();
        if (options.indexes) this.createIndexes(options.indexes);
        if (options.changeTracking) this.setupChangeTracking();

        // Create typed entity accessors (db.users, db.posts, etc.)
        for (const entityName of Object.keys(schemas)) {
            const key = entityName as keyof Schemas;
            const accessor: EntityAccessor<Schemas[typeof key]> = {
                insert: (data) => this.insert(entityName, data),
                get: (conditions) => this.get(entityName, conditions),
                update: (idOrData: any, data?: any) => {
                    if (typeof idOrData === 'number') return this.update(entityName, idOrData, data);
                    return this._createUpdateBuilder(entityName, idOrData);
                },
                upsert: (conditions, data) => this.upsert(entityName, data, conditions),
                delete: (id) => this.delete(entityName, id),
                subscribe: (event, callback) => this.subscribe(event, entityName, callback),
                unsubscribe: (event, callback) => this.unsubscribe(event, entityName, callback),
                select: (...cols: string[]) => this._createQueryBuilder(entityName, cols),
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
            const storableFieldNames = new Set(storableFields.map(f => f.name));
            const columnDefs = storableFields.map(f => `${f.name} ${zodTypeToSqlType(f.type)}`);
            const constraints: string[] = [];

            const belongsToRels = this.relationships.filter(
                rel => rel.type === 'belongs-to' && rel.from === entityName
            );
            for (const rel of belongsToRels) {
                if (!storableFieldNames.has(rel.foreignKey)) {
                    columnDefs.push(`${rel.foreignKey} INTEGER`);
                }
                constraints.push(`FOREIGN KEY (${rel.foreignKey}) REFERENCES ${rel.to}(id) ON DELETE SET NULL`);
            }

            const allCols = columnDefs.join(', ');
            const allConstraints = constraints.length > 0 ? ', ' + constraints.join(', ') : '';
            this.db.run(`CREATE TABLE IF NOT EXISTS ${entityName} (id INTEGER PRIMARY KEY AUTOINCREMENT, ${allCols}${allConstraints})`);
        }
    }

    private runMigrations(): void {
        this.db.run(`CREATE TABLE IF NOT EXISTS _schema_meta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      column_name TEXT NOT NULL,
      added_at TEXT DEFAULT (datetime('now')),
      UNIQUE(table_name, column_name)
    )`);

        for (const [entityName, schema] of Object.entries(this.schemas)) {
            const existingCols = new Set(
                (this.db.query(`PRAGMA table_info(${entityName})`).all() as any[]).map(c => c.name)
            );
            const storableFields = getStorableFields(schema);
            const fkColumns = this.relationships
                .filter(rel => rel.type === 'belongs-to' && rel.from === entityName)
                .map(rel => rel.foreignKey);

            for (const field of storableFields) {
                if (!existingCols.has(field.name)) {
                    this.db.run(`ALTER TABLE ${entityName} ADD COLUMN ${field.name} ${zodTypeToSqlType(field.type)}`);
                    this.db.query(`INSERT OR IGNORE INTO _schema_meta (table_name, column_name) VALUES (?, ?)`).run(entityName, field.name);
                }
            }
            for (const fk of fkColumns) {
                if (!existingCols.has(fk)) {
                    this.db.run(`ALTER TABLE ${entityName} ADD COLUMN ${fk} INTEGER`);
                    this.db.query(`INSERT OR IGNORE INTO _schema_meta (table_name, column_name) VALUES (?, ?)`).run(entityName, fk);
                }
            }
        }
    }

    // ===========================================================================
    // Indexes
    // ===========================================================================

    private createIndexes(indexDefs: Record<string, string | (string | string[])[]>): void {
        for (const [tableName, indexes] of Object.entries(indexDefs)) {
            if (!this.schemas[tableName]) throw new Error(`Cannot create index on unknown table '${tableName}'`);
            const indexList = Array.isArray(indexes) ? indexes : [indexes];
            for (const indexDef of indexList) {
                const columns = Array.isArray(indexDef) ? indexDef : [indexDef];
                const indexName = `idx_${tableName}_${columns.join('_')}`;
                this.db.run(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName} (${columns.join(', ')})`);
            }
        }
    }

    // ===========================================================================
    // Change Tracking
    // ===========================================================================

    private setupChangeTracking(): void {
        this.db.run(`CREATE TABLE IF NOT EXISTS _changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      row_id INTEGER NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('INSERT', 'UPDATE', 'DELETE')),
      changed_at TEXT DEFAULT (datetime('now'))
    )`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_changes_table ON _changes (table_name, id)`);

        for (const entityName of Object.keys(this.schemas)) {
            for (const action of ['insert', 'update', 'delete'] as const) {
                const ref = action === 'delete' ? 'OLD' : 'NEW';
                this.db.run(`CREATE TRIGGER IF NOT EXISTS _trg_${entityName}_${action}
          AFTER ${action.toUpperCase()} ON ${entityName}
          BEGIN
            INSERT INTO _changes (table_name, row_id, action) VALUES ('${entityName}', ${ref}.id, '${action.toUpperCase()}');
          END`);
            }
        }
    }

    public getChangeSeq(tableName?: string): number {
        if (!this.options.changeTracking) return -1;
        const sql = tableName
            ? `SELECT MAX(id) as seq FROM _changes WHERE table_name = ?`
            : `SELECT MAX(id) as seq FROM _changes`;
        const row = this.db.query(sql).get(...(tableName ? [tableName] : [])) as any;
        return row?.seq ?? 0;
    }

    public getChangesSince(sinceSeq: number, tableName?: string) {
        const sql = tableName
            ? `SELECT * FROM _changes WHERE id > ? AND table_name = ? ORDER BY id ASC`
            : `SELECT * FROM _changes WHERE id > ? ORDER BY id ASC`;
        return this.db.query(sql).all(...(tableName ? [sinceSeq, tableName] : [sinceSeq])) as any[];
    }

    // ===========================================================================
    // CRUD
    // ===========================================================================

    private insert<T extends Record<string, any>>(entityName: string, data: Omit<T, 'id'>): AugmentedEntity<any> {
        const schema = this.schemas[entityName]!;
        const processedData = preprocessRelationshipFields(schema, data);
        const validatedData = asZodObject(schema).passthrough().parse(processedData);
        const storableData = Object.fromEntries(
            Object.entries(validatedData).filter(([key]) => !isRelationshipField(schema, key))
        );
        const transformed = transformForStorage(storableData);
        const columns = Object.keys(transformed);

        const sql = columns.length === 0
            ? `INSERT INTO ${entityName} DEFAULT VALUES`
            : `INSERT INTO ${entityName} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;

        const result = this.db.query(sql).run(...Object.values(transformed));
        const newEntity = this.get(entityName, result.lastInsertRowid as number);
        if (!newEntity) throw new Error('Failed to retrieve entity after insertion');

        this.emit('insert', entityName, newEntity);
        this.subscriptions.insert[entityName]?.forEach(cb => cb(newEntity));
        return newEntity;
    }

    private get<T extends Record<string, any>>(entityName: string, conditions: number | Partial<T>): AugmentedEntity<any> | null {
        const q = typeof conditions === 'number' ? { id: conditions } : conditions;
        if (Object.keys(q).length === 0) return null;
        const results = this.find(entityName, { ...q, $limit: 1 });
        return results.length > 0 ? results[0] : null;
    }

    private findOne<T extends Record<string, any>>(entityName: string, conditions: Record<string, any>): AugmentedEntity<any> | null {
        const results = this.find(entityName, { ...conditions, $limit: 1 });
        return results.length > 0 ? results[0] : null;
    }

    private find<T extends Record<string, any>>(entityName: string, conditions: Record<string, any> = {}): AugmentedEntity<any>[] {
        return this.findSimple(entityName, conditions);
    }

    /** Simple query without includes */
    private findSimple(entityName: string, conditions: Record<string, any>): any[] {
        const { $limit, $offset, $sortBy, ...whereConditions } = conditions;
        const { clause, values } = this.buildWhereClause(whereConditions);

        let sql = `SELECT * FROM ${entityName} ${clause}`;
        if ($sortBy) {
            const [field, direction = 'ASC'] = ($sortBy as string).split(':');
            sql += ` ORDER BY ${field} ${direction.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`;
        }
        if ($limit) sql += ` LIMIT ${$limit}`;
        if ($offset) sql += ` OFFSET ${$offset}`;

        const rows = this.db.query(sql).all(...values);
        const entities = rows.map((row: any) => transformFromStorage(row, this.schemas[entityName]!));
        return entities.map(entity => this._attachMethods(entityName, entity));
    }

    private update<T extends Record<string, any>>(entityName: string, id: number, data: Partial<Omit<T, 'id'>>): AugmentedEntity<any> | null {
        const schema = this.schemas[entityName]!;
        const validatedData = asZodObject(schema).partial().parse(data);
        const transformed = transformForStorage(validatedData);
        if (Object.keys(transformed).length === 0) return this.get(entityName, { id } as any);

        const setClause = Object.keys(transformed).map(key => `${key} = ?`).join(', ');
        this.db.query(`UPDATE ${entityName} SET ${setClause} WHERE id = ?`).run(...Object.values(transformed), id);

        const updatedEntity = this.get(entityName, { id } as any);
        if (updatedEntity) {
            this.emit('update', entityName, updatedEntity);
            this.subscriptions.update[entityName]?.forEach(cb => cb(updatedEntity));
        }
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
        if (affected > 0 && (this.subscriptions.update[entityName]?.length || this.options.changeTracking)) {
            for (const entity of this.find(entityName, conditions)) {
                this.emit('update', entityName, entity);
                this.subscriptions.update[entityName]?.forEach(cb => cb(entity));
            }
        }
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
        const schema = this.schemas[entityName]!;
        const processedData = preprocessRelationshipFields(schema, data);
        const processedConditions = preprocessRelationshipFields(schema, conditions);
        const hasId = processedData.id && typeof processedData.id === 'number';
        const existing = hasId
            ? this.get(entityName, { id: processedData.id } as any)
            : Object.keys(processedConditions).length > 0
                ? this.get(entityName, processedConditions)
                : null;

        if (existing) {
            const updateData = { ...processedData };
            delete updateData.id;
            return this.update(entityName, existing.id, updateData) as AugmentedEntity<any>;
        }
        const insertData = { ...processedConditions, ...processedData };
        delete insertData.id;
        return this.insert(entityName, insertData);
    }

    private delete(entityName: string, id: number): void {
        const entity = this.get(entityName, { id });
        if (entity) {
            this.db.query(`DELETE FROM ${entityName} WHERE id = ?`).run(id);
            this.emit('delete', entityName, entity);
            this.subscriptions.delete[entityName]?.forEach(cb => cb(entity));
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
                // book.author() → lazy load parent
                augmented[rel.relationshipField] = () => {
                    const fkValue = entity[rel.foreignKey];
                    return fkValue ? this.get(rel.to, { id: fkValue }) : null;
                };
            } else if (rel.from === entityName && rel.type === 'one-to-many') {
                // author.books() → lazy load children
                const belongsToRel = this.relationships.find(
                    r => r.type === 'belongs-to' && r.from === rel.to && r.to === rel.from
                );
                if (belongsToRel) {
                    const fk = belongsToRel.foreignKey;
                    augmented[rel.relationshipField] = () => {
                        return this.find(rel.to, { [fk]: entity.id });
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

    /**
     * Transform entity references in conditions to FK values.
     * e.g. { author: tolstoy } → { authorId: tolstoy.id }
     */
    private resolveEntityConditions(conditions: Record<string, any>): Record<string, any> {
        const resolved: Record<string, any> = {};
        for (const [key, value] of Object.entries(conditions)) {
            // Check if the key matches a belongs-to relationship across any schema
            const rel = this.relationships.find(
                r => r.type === 'belongs-to' && r.relationshipField === key
            );
            if (rel && value && typeof value === 'object' && 'id' in value) {
                // Replace { author: entity } → { authorId: entity.id }
                resolved[rel.foreignKey] = value.id;
            } else {
                resolved[key] = value;
            }
        }
        return resolved;
    }

    private buildWhereClause(conditions: Record<string, any>, tablePrefix?: string): { clause: string; values: any[] } {
        const parts: string[] = [];
        const values: any[] = [];

        // Resolve relationship fields: { author: tolstoy } → { authorId: tolstoy.id }
        const resolvedConditions = this.resolveEntityConditions(conditions);

        for (const key in resolvedConditions) {
            if (key.startsWith('$')) {
                // Handle $or
                if (key === '$or' && Array.isArray(resolvedConditions[key])) {
                    const orBranches = resolvedConditions[key] as Record<string, any>[];
                    const orParts: string[] = [];
                    for (const branch of orBranches) {
                        const sub = this.buildWhereClause(branch, tablePrefix);
                        if (sub.clause) {
                            // Strip the leading "WHERE " from the sub-clause
                            orParts.push(`(${sub.clause.replace(/^WHERE /, '')})`);
                            values.push(...sub.values);
                        }
                    }
                    if (orParts.length > 0) parts.push(`(${orParts.join(' OR ')})`);
                }
                continue;
            }
            const value = resolvedConditions[key];
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
    // Events
    // ===========================================================================

    private subscribe(event: 'insert' | 'update' | 'delete', entityName: string, callback: (data: any) => void): void {
        this.subscriptions[event][entityName] = this.subscriptions[event][entityName] || [];
        this.subscriptions[event][entityName].push(callback);
    }

    private unsubscribe(event: 'insert' | 'update' | 'delete', entityName: string, callback: (data: any) => void): void {
        if (this.subscriptions[event][entityName]) {
            this.subscriptions[event][entityName] = this.subscriptions[event][entityName].filter(cb => cb !== callback);
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

        const conditionResolver = (conditions: Record<string, any>) =>
            this.resolveEntityConditions(conditions);

        const builder = new QueryBuilder(entityName, executor, singleExecutor, joinResolver, conditionResolver);
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

const Database = _Database as unknown as new <S extends SchemaMap>(
    dbFile: string, schemas: S, options?: DatabaseOptions
) => _Database<S> & TypedAccessors<S>;

type Database<S extends SchemaMap> = _Database<S> & TypedAccessors<S>;

export { Database };
export type { Database as DatabaseType };
