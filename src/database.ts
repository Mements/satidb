/**
 * database.ts — Main Database class for sqlite-zod-orm
 *
 * Slim orchestrator: initializes the schema, creates tables/triggers,
 * and delegates CRUD, entity augmentation, and query building to
 * focused modules.
 */
import { Database as SqliteDatabase } from "bun:sqlite";
import { createMeasure } from "measure-fn";
import { z } from "zod";
import {
  QueryBuilder,
  executeProxyQuery,
  createQueryBuilder,
  type ProxyQueryResult,
} from "./query";
import type {
  SchemaMap,
  DatabaseOptions,
  Relationship,
  RelationsConfig,
  EntityAccessor,
  TypedAccessors,
  TypedNavAccessors,
  AugmentedEntity,
  UpdateBuilder,
  ProxyColumns,
  InferSchema,
  ChangeEvent,
  ViewDefinitions,
  ViewDefinition,
  TypedReadonlyAccessors,
} from "./types";
import { asZodObject } from "./types";
import {
  parseRelationsConfig,
  getStorableFields,
  zodTypeToSqlType,
} from "./schema";
import { transformFromStorage } from "./schema";
import type { DatabaseContext } from "./context";
import type { PendingInsertOperation } from "./conflict";
import { buildWhereClause } from "./helpers";
import { attachMethods } from "./entity";
import {
  insert,
  insertMany,
  update,
  upsert,
  upsertMany,
  findOrCreate,
  deleteEntity,
  createDeleteBuilder,
  getById,
  getOne,
  findMany,
  updateWhere,
  createUpdateBuilder,
} from "./crud";

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
  private _timestamps: boolean;
  private _softDeletes: boolean;
  private _debug: boolean;
  private schemas: Schemas;
  private allSchemas: SchemaMap;
  private viewDefinitions: ViewDefinitions;
  private relationships: Relationship[];
  private options: DatabaseOptions<any, any>;

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

  /** Scoped measure-fn instance for instrumentation. */
  private _measure: ReturnType<typeof createMeasure>;

  /** Prepared statement cache — avoids re-compiling identical SQL. */
  private _stmtCache = new Map<string, ReturnType<SqliteDatabase["query"]>>();

  /** Lazy inserts waiting to be executed before the next ORM operation. */
  private _pendingInserts = new Set<PendingInsertOperation>();

  /** Reentrancy guard while flushing lazy inserts. */
  private _flushingPendingInserts = false;

  /** Get or create a cached prepared statement. */
  private _stmt(sql: string): ReturnType<SqliteDatabase["query"]> {
    let stmt = this._stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.query(sql);
      this._stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  /**
   * Conditional measurement helper — wraps with measure-fn only when debug is on.
   * When debug is off, executes fn directly with zero overhead.
   */
  private _m<T>(label: string, fn: () => T): T {
    if (!this._flushingPendingInserts && this._pendingInserts.size > 0) {
      this._flushPendingInserts();
    }
    if (this._debug) return this._measure.measureSync.assert(label, fn);
    return fn();
  }

  private _registerPendingInsert(operation: PendingInsertOperation): void {
    this._pendingInserts.add(operation);
  }

  private _unregisterPendingInsert(operation: PendingInsertOperation): void {
    this._pendingInserts.delete(operation);
  }

  private _flushPendingInserts(): void {
    if (this._flushingPendingInserts || this._pendingInserts.size === 0) return;
    this._flushingPendingInserts = true;
    try {
      for (const operation of [...this._pendingInserts]) {
        if (operation.isPending()) operation.execute();
      }
    } finally {
      this._flushingPendingInserts = false;
    }
  }

  constructor(
    dbFile: string,
    schemas: Schemas,
    options: DatabaseOptions<any, any> = {},
  ) {
    this._debug = options.debug === true;
    this._measure = createMeasure("satidb");

    this.db = new SqliteDatabase(dbFile);
    if (options.wal !== false) this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.schemas = schemas;
    this.viewDefinitions = options.views ?? {};
    this.allSchemas = {
      ...this.schemas,
      ...Object.fromEntries(
        Object.entries(this.viewDefinitions).map(([viewName, def]) => [
          viewName,
          def.schema,
        ]),
      ),
    };
    this.options = options;
    this._reactive = options.reactive !== false; // default true
    this._timestamps = options.timestamps === true;
    this._softDeletes = options.softDeletes === true;
    this._pollInterval = options.pollInterval ?? 100;
    this.relationships = options.relations
      ? parseRelationsConfig(options.relations, this.allSchemas)
      : [];

    // Build the context that extracted modules use
    this._ctx = {
      db: this.db,
      schemas: this.allSchemas,
      relationships: this.relationships,
      viewNames: new Set(Object.keys(this.viewDefinitions)),
      attachMethods: (name, entity) => attachMethods(this._ctx, name, entity),
      buildWhereClause: (conds, prefix) => buildWhereClause(conds, prefix),
      debug: this._debug,
      timestamps: this._timestamps,
      softDeletes: this._softDeletes,
      hooks: options.hooks ?? {},
      computed: options.computed ?? {},
      cascade: options.cascade ?? {},
      _m: <T>(label: string, fn: () => T): T => this._m(label, fn),
      _stmt: (sql: string) => this._stmt(sql),
      _registerPendingInsert: (operation) =>
        this._registerPendingInsert(operation),
      _unregisterPendingInsert: (operation) =>
        this._unregisterPendingInsert(operation),
      _flushPendingInserts: () => this._flushPendingInserts(),
    };

    this._m("Sync tables", () => this.syncTablesToSchemas());
    if (options.indexes)
      this._m("Create indexes", () => this.createIndexes(options.indexes!));
    if (options.unique)
      this._m("Unique constraints", () =>
        this.createUniqueConstraints(options.unique!),
      );
    if (options.views)
      this._m("Create views", () => this.createOrUpdateViews(options.views!));
    if (this._reactive)
      this._m("Change tracking", () => this.initializeChangeTracking());

    // Create typed entity accessors (db.users, db.posts, etc.)
    for (const entityName of Object.keys(schemas)) {
      const key = entityName as keyof Schemas;
      const accessor: EntityAccessor<Schemas[typeof key]> = {
        get: (id: number) =>
          this._m(`${entityName}.get`, () =>
            getById(this._ctx, entityName, id),
          ),
        insert: (data) =>
          this._m(`${entityName}.insert`, () =>
            insert(this._ctx, entityName, data),
          ),
        insertMany: (rows: any[]) =>
          this._m(`${entityName}.insertMany(${rows.length})`, () =>
            insertMany(this._ctx, entityName, rows),
          ),
        update: (idOrData: any, data?: any) => {
          if (typeof idOrData === "number")
            return this._m(`${entityName}.update(${idOrData})`, () =>
              update(this._ctx, entityName, idOrData, data),
            );
          return createUpdateBuilder(this._ctx, entityName, idOrData);
        },
        upsert: (conditions, data) =>
          this._m(`${entityName}.upsert`, () =>
            upsert(this._ctx, entityName, data, conditions),
          ),
        upsertMany: (rows: any[], conditions?: any) =>
          this._m(`${entityName}.upsertMany(${rows.length})`, () =>
            upsertMany(this._ctx, entityName, rows, conditions),
          ),
        findOrCreate: (conditions: any, defaults?: any) =>
          this._m(`${entityName}.findOrCreate`, () =>
            findOrCreate(this._ctx, entityName, conditions, defaults),
          ),
        delete: ((id?: any) => {
          if (typeof id === "number") {
            return this._m(`${entityName}.delete(${id})`, () => {
              // beforeDelete hook — return false to cancel
              const hooks = this._ctx.hooks[entityName];
              if (hooks?.beforeDelete) {
                const result = hooks.beforeDelete(id);
                if (result === false) return;
              }

              // Cascade delete children first
              const cascadeTargets = this._ctx.cascade[entityName];
              if (cascadeTargets) {
                for (const childTable of cascadeTargets) {
                  const rel = this._ctx.relationships.find(
                    (r) =>
                      r.type === "belongs-to" &&
                      r.from === childTable &&
                      r.to === entityName,
                  );
                  if (rel) {
                    if (this._softDeletes) {
                      const now = new Date().toISOString();
                      this._stmt(
                        `UPDATE "${childTable}" SET "deletedAt" = ? WHERE "${rel.foreignKey}" = ?`,
                      ).run(now, id);
                    } else {
                      this._stmt(
                        `DELETE FROM "${childTable}" WHERE "${rel.foreignKey}" = ?`,
                      ).run(id);
                    }
                  }
                }
              }

              if (this._softDeletes) {
                const now = new Date().toISOString();
                this._stmt(
                  `UPDATE "${entityName}" SET "deletedAt" = ? WHERE id = ?`,
                ).run(now, id);
                if (hooks?.afterDelete) hooks.afterDelete(id);
                return;
              }
              return deleteEntity(this._ctx, entityName, id);
            });
          }
          return createDeleteBuilder(this._ctx, entityName);
        }) as any,
        restore: ((id: number) => {
          if (!this._softDeletes)
            throw new Error("restore() requires softDeletes: true");
          this._m(`${entityName}.restore(${id})`, () => {
            this._stmt(
              `UPDATE "${entityName}" SET "deletedAt" = NULL WHERE id = ?`,
            ).run(id);
          });
        }) as any,
        select: (...cols: string[]) =>
          createQueryBuilder(this._ctx, entityName, cols),
        count: () =>
          this._m(`${entityName}.count`, () => {
            const row = this._stmt(
              `SELECT COUNT(*) as count FROM "${entityName}"${this._softDeletes ? ' WHERE "deletedAt" IS NULL' : ""}`,
            ).get() as any;
            return row?.count ?? 0;
          }),
        on: (
          event: ChangeEvent,
          callback: (row: any) => void | Promise<void>,
        ) => {
          return this._registerListener(entityName, event, callback);
        },
        _tableName: entityName,
      };
      (this as any)[key] = accessor;
    }

    for (const [viewName, def] of Object.entries(this.viewDefinitions)) {
      const key = viewName as keyof typeof this.viewDefinitions;
      (this as any)[key] = this.createReadonlyAccessor(viewName, def);
    }
  }

  // =========================================================================
  // Table Initialization & Migrations
  // =========================================================================

  private syncTablesToSchemas(): void {
    // Schema-first behavior: the Zod schema is the source of truth.
    // If an existing table was created from an older/incompatible schema,
    // keep its data by renaming it to table_vN and create a fresh table.
    // We loop because renaming a parent table can cause SQLite to rewrite
    // child table FK SQL to point at the backup name; the next pass catches
    // and repairs those dependent tables too.
    const maxPasses = Math.max(1, Object.keys(this.schemas).length + 1);

    for (let pass = 0; pass < maxPasses; pass++) {
      let changed = false;

      for (const [entityName, schema] of Object.entries(this.schemas)) {
        const expectedSql = this.createTableSql(entityName, schema);
        const existing = this.db
          .query(
            `SELECT type, sql FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')`,
          )
          .get(entityName) as { type?: string; sql?: string | null } | null;

        if (!existing) {
          this.db.run(expectedSql);
          changed = true;
          continue;
        }

        if (existing.type !== "table") {
          throw new Error(`"${entityName}" already exists and is not a table.`);
        }

        if (
          this.normalizeSql(existing.sql ?? "") !==
          this.normalizeSql(expectedSql)
        ) {
          this.backupAndRecreateTable(entityName, schema);
          changed = true;
          continue;
        }
      }

      if (!changed) return;
    }

    throw new Error(
      "Schema sync did not stabilize. Check for conflicting table/view definitions.",
    );
  }

  private createTableSql(entityName: string, schema: z.ZodType<any>): string {
    const storableFields = getStorableFields(schema);
    const columnDefs = storableFields.map(
      (f) => `"${f.name}" ${zodTypeToSqlType(f.type)}`,
    );

    // Add timestamp columns
    if (this._timestamps) {
      columnDefs.push('"createdAt" TEXT');
      columnDefs.push('"updatedAt" TEXT');
    }
    // Add soft delete column
    if (this._softDeletes) {
      columnDefs.push('"deletedAt" TEXT');
    }

    const constraints: string[] = [];

    const belongsToRels = this.relationships.filter(
      (rel) => rel.type === "belongs-to" && rel.from === entityName,
    );
    for (const rel of belongsToRels) {
      constraints.push(
        `FOREIGN KEY ("${rel.foreignKey}") REFERENCES "${rel.to}"(id) ON DELETE SET NULL`,
      );
    }

    const body = [
      "id INTEGER PRIMARY KEY AUTOINCREMENT",
      ...columnDefs,
      ...constraints,
    ].join(", ");
    return `CREATE TABLE "${entityName}" (${body})`;
  }

  private backupAndRecreateTable(
    entityName: string,
    schema: z.ZodType<any>,
  ): void {
    const backupName = this.nextBackupTableName(entityName);

    const txn = this.db.transaction(() => {
      // Index and trigger names are global in SQLite. Drop ORM-owned ones
      // before the rename so the fresh table can recreate them with the
      // normal idx_/uq_/_trg_ names.
      this.dropOrmManagedIndexes(entityName);
      this.dropOrmManagedTriggers(entityName);

      this.db.run(`ALTER TABLE "${entityName}" RENAME TO "${backupName}"`);
      this.db.run(this.createTableSql(entityName, schema));
    });

    txn();
  }

  private nextBackupTableName(tableName: string): string {
    let version = 1;
    while (this.objectExists(`${tableName}_v${version}`)) {
      version++;
    }
    return `${tableName}_v${version}`;
  }

  private objectExists(name: string): boolean {
    const row = this.db
      .query(`SELECT 1 FROM sqlite_master WHERE name = ? LIMIT 1`)
      .get(name) as any;
    return !!row;
  }

  private dropOrmManagedIndexes(tableName: string): void {
    const rows = this.db
      .query(
        `SELECT name
             FROM sqlite_master
             WHERE type = 'index'
               AND tbl_name = ?
               AND sql IS NOT NULL`,
      )
      .all(tableName) as { name: string }[];

    const ownedPrefixes = [`idx_${tableName}_`, `uq_${tableName}_`];
    for (const row of rows) {
      if (!ownedPrefixes.some((prefix) => row.name.startsWith(prefix)))
        continue;
      this.db.run(`DROP INDEX IF EXISTS "${this.escapeIdentifier(row.name)}"`);
    }
  }

  private dropOrmManagedTriggers(tableName: string): void {
    for (const event of ["insert", "update", "delete"]) {
      const triggerName = `_trg_${tableName}_${event}`;
      this.db.run(
        `DROP TRIGGER IF EXISTS "${this.escapeIdentifier(triggerName)}"`,
      );
    }
  }

  private escapeIdentifier(value: string): string {
    return value.replace(/"/g, '""');
  }

  /**
   * Initialize per-table change tracking using triggers.
   *
   * Creates a `_changes` table that logs every insert/update/delete with
   * the table name, operation, and affected row id. This enables
   * row-level change detection for the `on()` API.
   */
  private initializeChangeTracking(): void {
    this.db.run(`CREATE TABLE IF NOT EXISTS "_changes" (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tbl TEXT NOT NULL,
            op TEXT NOT NULL,
            row_id INTEGER NOT NULL
        )`);

    for (const entityName of Object.keys(this.schemas)) {
      // INSERT trigger — logs NEW.id
      this.db.run(`CREATE TRIGGER IF NOT EXISTS "_trg_${entityName}_insert"
                AFTER INSERT ON "${entityName}"
                BEGIN
                    INSERT INTO "_changes" (tbl, op, row_id) VALUES ('${entityName}', 'insert', NEW.id);
                END`);

      // UPDATE trigger — logs NEW.id (post-update row)
      this.db.run(`CREATE TRIGGER IF NOT EXISTS "_trg_${entityName}_update"
                AFTER UPDATE ON "${entityName}"
                BEGIN
                    INSERT INTO "_changes" (tbl, op, row_id) VALUES ('${entityName}', 'update', NEW.id);
                END`);

      // DELETE trigger — logs OLD.id (row that was deleted)
      this.db.run(`CREATE TRIGGER IF NOT EXISTS "_trg_${entityName}_delete"
                AFTER DELETE ON "${entityName}"
                BEGIN
                    INSERT INTO "_changes" (tbl, op, row_id) VALUES ('${entityName}', 'delete', OLD.id);
                END`);
    }

    // Initialize watermark to current max (skip replaying historical changes)
    const row = this.db
      .query('SELECT MAX(id) as maxId FROM "_changes"')
      .get() as any;
    this._changeWatermark = row?.maxId ?? 0;
  }

  private createIndexes(indexes: Record<string, (string | string[])[]>): void {
    for (const [tableName, indexDefs] of Object.entries(indexes)) {
      for (const def of indexDefs) {
        const cols = Array.isArray(def) ? def : [def];
        const idxName = `idx_${tableName}_${cols.join("_")}`;
        this.db.run(
          `CREATE INDEX IF NOT EXISTS "${idxName}" ON "${tableName}" (${cols.map((c) => `"${c}"`).join(", ")})`,
        );
      }
    }
  }

  private createUniqueConstraints(unique: Record<string, string[][]>): void {
    for (const [tableName, groups] of Object.entries(unique)) {
      for (const cols of groups) {
        const idxName = `uq_${tableName}_${cols.join("_")}`;
        this.db.run(
          `CREATE UNIQUE INDEX IF NOT EXISTS "${idxName}" ON "${tableName}" (${cols.map((c) => `"${c}"`).join(", ")})`,
        );
      }
    }
  }

  private createOrUpdateViews(views: ViewDefinitions): void {
    for (const [viewName, def] of Object.entries(views)) {
      const selectSql = this.normalizeViewSelect(def.as);
      const createSql = `CREATE VIEW "${viewName}" AS ${selectSql}`;
      const existing = this.db
        .query("SELECT type, sql FROM sqlite_master WHERE name = ?")
        .get(viewName) as { type?: string; sql?: string | null } | null;

      if (!existing) {
        this.db.run(createSql);
        continue;
      }

      if (existing.type !== "view") {
        throw new Error(`"${viewName}" already exists and is not a view.`);
      }

      if (
        this.normalizeSql(existing.sql ?? "") !== this.normalizeSql(createSql)
      ) {
        this.db.run(`DROP VIEW IF EXISTS "${viewName}"`);
        this.db.run(createSql);
      }
    }
  }

  private createReadonlyAccessor(
    viewName: string,
    _def: ViewDefinition,
  ): Record<string, any> {
    const readonlyError = () => {
      throw new Error(`"${viewName}" is a read-only view.`);
    };

    return {
      insert: readonlyError,
      insertMany: readonlyError,
      update: readonlyError,
      upsert: readonlyError,
      upsertMany: readonlyError,
      findOrCreate: readonlyError,
      delete: readonlyError,
      restore: readonlyError,
      select: (...cols: string[]) =>
        createQueryBuilder(this._ctx, viewName, cols),
      count: () =>
        this._m(`${viewName}.count`, () => {
          const row = this._stmt(
            `SELECT COUNT(*) as count FROM "${viewName}"`,
          ).get() as any;
          return row?.count ?? 0;
        }),
      on: readonlyError,
      _tableName: viewName,
      _isView: true,
    };
  }

  private normalizeViewSelect(sql: string): string {
    return sql.trim().replace(/;+\s*$/, "");
  }

  private normalizeSql(sql: string): string {
    return sql.replace(/\s+/g, " ").trim().toLowerCase();
  }

  // =========================================================================
  // Change Listeners — db.table.on('insert' | 'update' | 'delete', cb)
  // =========================================================================

  private _registerListener(
    table: string,
    event: ChangeEvent,
    callback: (row: any) => void | Promise<void>,
  ): () => void {
    if (!this._reactive) {
      throw new Error(
        "Change listeners are disabled. Set { reactive: true } (or omit it) in Database options to enable .on().",
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
    this._pollTimer = setInterval(
      () => this._processChanges(),
      this._pollInterval,
    );
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
    const head = this._stmt('SELECT MAX(id) as m FROM "_changes"').get() as any;
    const maxId: number = head?.m ?? 0;
    if (maxId <= this._changeWatermark) return;

    const changes = this._stmt(
      'SELECT id, tbl, op, row_id FROM "_changes" WHERE id > ? ORDER BY id',
    ).all(this._changeWatermark) as {
      id: number;
      tbl: string;
      op: string;
      row_id: number;
    }[];

    for (const change of changes) {
      const listeners = this._listeners.filter(
        (l) => l.table === change.tbl && l.event === change.op,
      );

      if (listeners.length > 0) {
        if (change.op === "delete") {
          // Row is gone — pass just the id
          const payload = { id: change.row_id };
          for (const l of listeners) {
            try {
              l.callback(payload);
            } catch {
              /* listener error */
            }
          }
        } else {
          // insert or update — re-fetch the current row
          const row = getById(this._ctx, change.tbl, change.row_id);
          if (row) {
            for (const l of listeners) {
              try {
                l.callback(row);
              } catch {
                /* listener error */
              }
            }
          }
        }
      }

      this._changeWatermark = change.id;
    }

    // Clean up consumed changes
    this._stmt('DELETE FROM "_changes" WHERE id <= ?').run(
      this._changeWatermark,
    );
  }

  // =========================================================================
  // Transactions
  // =========================================================================

  public transaction<T>(callback: () => T): T {
    return this._m("transaction", () => this.db.transaction(callback)());
  }

  /** Close the database: stops polling, clears cache, and releases the SQLite handle. */
  public close(): void {
    this._flushPendingInserts();
    this._stopPolling();
    this._stmtCache.clear();
    this.db.close();
  }

  // =========================================================================
  // Proxy Query
  // =========================================================================

  /** Proxy callback query for complex SQL-like JOINs */
  public query<T extends Record<string, any> = Record<string, any>>(
    callback: (ctx: {
      [K in keyof Schemas]: ProxyColumns<InferSchema<Schemas[K]>>;
    }) => ProxyQueryResult,
  ): T[] {
    return this._m("query(proxy)", () =>
      executeProxyQuery(
        this.schemas,
        callback as any,
        (sql: string, params: any[]) => {
          return this._stmt(sql).all(...params) as T[];
        },
      ),
    );
  }

  // =========================================================================
  // Raw SQL
  // =========================================================================

  /** Execute a raw SQL query and return results. */
  public raw<T = any>(sql: string, ...params: any[]): T[] {
    return this._m(
      `raw: ${sql.slice(0, 60)}`,
      () => this._stmt(sql).all(...params) as T[],
    );
  }

  /** Execute a raw SQL statement (INSERT/UPDATE/DELETE) without returning rows. */
  public exec(sql: string, ...params: any[]): void {
    this._m(`exec: ${sql.slice(0, 60)}`, () => this.db.run(sql, ...params));
  }

  // =========================================================================
  // Schema Introspection
  // =========================================================================

  /** Return the list of user-defined table names. */
  public tables(): string[] {
    return Object.keys(this.schemas);
  }

  /** Return the list of registered view names. */
  public views(): string[] {
    return Object.keys(this.viewDefinitions);
  }

  /** Return column info for a table via PRAGMA table_info. */
  public columns(
    tableName: string,
  ): { name: string; type: string; notnull: number; pk: number }[] {
    return this.db.query(`PRAGMA table_info("${tableName}")`).all() as any[];
  }

  // =========================================================================
  // Data Import / Export
  // =========================================================================

  /**
   * Export all data as a JSON-serializable object.
   * Each key is a table name, value is an array of raw row objects.
   */
  public dump(): Record<string, any[]> {
    return this._m("dump", () => {
      const result: Record<string, any[]> = {};
      for (const tableName of Object.keys(this.schemas)) {
        result[tableName] = this.db.query(`SELECT * FROM "${tableName}"`).all();
      }
      return result;
    });
  }

  /**
   * Import data from a dump object. Truncates existing data first.
   * Use `{ append: true }` to insert without truncating.
   */
  public load(
    data: Record<string, any[]>,
    options?: { append?: boolean },
  ): void {
    this._m(`load(${Object.keys(data).join(",")})`, () => {
      const txn = this.db.transaction(() => {
        for (const [tableName, rows] of Object.entries(data)) {
          if (!this.schemas[tableName]) continue;
          if (!options?.append) {
            this.db.run(`DELETE FROM "${tableName}"`);
          }
          for (const row of rows) {
            const cols = Object.keys(row).filter((k) => k !== "id");
            const placeholders = cols.map(() => "?").join(", ");
            const values = cols.map((c) => {
              const v = row[c];
              if (
                v !== null &&
                v !== undefined &&
                typeof v === "object" &&
                !(v instanceof Buffer)
              ) {
                return JSON.stringify(v);
              }
              return v;
            });
            this.db
              .query(
                `INSERT INTO "${tableName}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`,
              )
              .run(...values);
          }
        }
      });
      txn();
    });
  }

  /**
   * Seed tables with fixture data. Each key is a table name, value is an
   * array of records to insert. Does NOT truncate — use for additive seeding.
   */
  public seed(fixtures: Record<string, Record<string, any>[]>): void {
    this.load(fixtures, { append: true });
  }

  // =========================================================================
  // Schema Diffing
  // =========================================================================

  /**
   * Compare Zod schemas against the live SQLite table structure.
   * Returns a diff object per table: { added, removed, typeChanged }.
   */
  public diff(): Record<
    string,
    {
      added: string[];
      removed: string[];
      typeChanged: { column: string; expected: string; actual: string }[];
    }
  > {
    return this._m("diff", () => {
      const result: Record<
        string,
        {
          added: string[];
          removed: string[];
          typeChanged: { column: string; expected: string; actual: string }[];
        }
      > = {};
      const systemCols = new Set(["id", "createdAt", "updatedAt", "deletedAt"]);

      for (const [tableName, schema] of Object.entries(this.schemas)) {
        const schemaFields = getStorableFields(schema);
        const schemaColMap = new Map(
          schemaFields.map((f) => [f.name, zodTypeToSqlType(f.type)]),
        );

        const liveColumns = this.columns(tableName);
        const liveColMap = new Map(liveColumns.map((c) => [c.name, c.type]));

        const added: string[] = [];
        const removed: string[] = [];
        const typeChanged: {
          column: string;
          expected: string;
          actual: string;
        }[] = [];

        for (const [col, expectedType] of schemaColMap) {
          if (!liveColMap.has(col)) {
            added.push(col);
          } else {
            const actualType = liveColMap.get(col)!;
            if (actualType !== expectedType) {
              typeChanged.push({
                column: col,
                expected: expectedType,
                actual: actualType,
              });
            }
          }
        }

        for (const col of liveColMap.keys()) {
          if (!systemCols.has(col) && !schemaColMap.has(col)) {
            removed.push(col);
          }
        }

        if (added.length > 0 || removed.length > 0 || typeChanged.length > 0) {
          result[tableName] = { added, removed, typeChanged };
        }
      }

      return result;
    });
  }
}

// =============================================================================
// Public Export
// =============================================================================

type ViewSchemas<V extends ViewDefinitions> = {
  [K in keyof V]: V[K] extends ViewDefinition<infer T> ? T : never;
};

type Database<
  S extends SchemaMap,
  R extends RelationsConfig = {},
  V extends ViewDefinitions = {},
> = _Database<S> &
  TypedNavAccessors<S, R> &
  TypedReadonlyAccessors<ViewSchemas<V>>;

const Database = _Database as unknown as new <
  S extends SchemaMap,
  const R extends RelationsConfig = {},
  const V extends ViewDefinitions = {},
>(
  dbFile: string,
  schemas: S,
  options?: DatabaseOptions<R, V>,
) => Database<S, R, V>;

export { Database };
export type { Database as DatabaseType };
