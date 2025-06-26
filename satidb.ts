import { Database } from 'bun:sqlite';
import { EventEmitter } from 'events';
import { z } from 'zod';
import { createHash } from 'crypto';

type ZodType = z.ZodTypeAny;
type SchemaMap = Record<string, z.ZodObject<any>>;

type Relationship = {
  type: 'belongs-to' | 'one-to-many';
  from: string;
  to: string;
  relationshipField: string; // e.g., 'chats' in Personality for one-to-many
  foreignKey: string; // e.g., 'personalityId' in Chat
};

type LazyMethod<T = any, R = any> = {
  name: string;
  type: Relationship['type'];
  fetch: (entity: T) => R;
  childEntityName?: string;
  parentEntityName?: string;
};

/**
 * A custom SQLite database wrapper with schema validation, relationships, and event handling.
 */
class MyDatabase extends EventEmitter {
  private db: Database;
  private schemas: SchemaMap;
  private relationships: Relationship[];
  private lazyMethods: Record<string, LazyMethod[]>;
  private subscriptions: Record<'insert' | 'update' | 'delete', Record<string, ((data: any) => void)[]>>;

  /**
   * Creates a new MyDatabase instance.
   * @param dbFile Path to the SQLite database file (e.g., ':memory:' for in-memory).
   * @param schemas Record of entity names to Zod schemas.
   */
  constructor(dbFile: string, schemas: SchemaMap) {
    super();
    this.db = new Database(dbFile);
    this.db.run('PRAGMA foreign_keys = ON'); // Enable foreign key constraints
    this.schemas = schemas;
    this.subscriptions = { insert: {}, update: {}, delete: {} };
    this.relationships = this.parseRelationships(schemas);
    this.lazyMethods = this.buildLazyMethods();
    this.initializeTables();

    for (const entityName of Object.keys(schemas)) {
      // Make the entity accessor callable for find operations
      const accessor: any = (conditions: any) => this.find(entityName, conditions);

      // Attach other methods to the accessor function object
      accessor.insert = (data: any) => this.insert(entityName, data);
      accessor.get = (conditions: any) => this.get(entityName, conditions);
      accessor.update = (id: string, data: any) => this.update(entityName, id, data);
      accessor.upsert = (data: any, conditions?: any) => this.upsert(entityName, data, conditions);
      accessor.delete = (id: string) => this.delete(entityName, id);
      accessor.subscribe = (event: 'insert' | 'update' | 'delete', callback: (data: any) => void) => {
        this.subscribe(event, entityName, callback);
      };

      (this as any)[entityName] = accessor;
    }
  }

  /**
   * Generates a unique ID based on entity data.
   * @param entityName Entity name.
   * @param data Data to hash.
   * @returns A 16-character hash-based ID.
   */
  private generateId(entityName: string, data: Record<string, any>): string {
    const schema = this.schemas[entityName];
    const hashableData = Object.fromEntries(
      Object.entries(data).filter(([key]) => !this.isRelationshipField(schema, key))
    );
    const hash = createHash('sha256').update(JSON.stringify(hashableData)).digest('hex');
    return hash.substring(0, 16);
  }

  /**
   * Parses relationships from Zod schemas.
   * @param schemas Schema map.
   * @returns Array of relationships.
   */
  private parseRelationships(schemas: SchemaMap): Relationship[] {
    const relationships: Relationship[] = [];
    for (const [entityName, schema] of Object.entries(schemas)) {
      const shape = schema.shape as Record<string, ZodType>;
      for (const [fieldName, fieldSchema] of Object.entries(shape)) {
        let actualSchema = fieldSchema;
        if (actualSchema instanceof z.ZodOptional) {
          actualSchema = actualSchema._def.innerType;
        }

        if (actualSchema instanceof z.ZodLazy) {
          const lazySchema = actualSchema._def.getter();
          let relType: 'belongs-to' | 'one-to-many' | null = null;
          let targetSchema: z.ZodObject<any> | null = null;

          if (lazySchema instanceof z.ZodArray) {
            relType = 'one-to-many';
            targetSchema = lazySchema._def.type;
          } else {
            relType = 'belongs-to';
            targetSchema = lazySchema;
          }

          if (relType && targetSchema) {
            const targetEntityName = Object.keys(schemas).find(
              name => schemas[name] === targetSchema
            );
            if (targetEntityName) {
              const singularTarget = targetEntityName.endsWith('s') ? targetEntityName.slice(0, -1) : targetEntityName;
              const foreignKey = `${singularTarget}Id`;
              relationships.push({
                type: relType,
                from: entityName,
                to: targetEntityName,
                relationshipField: fieldName,
                foreignKey: relType === 'belongs-to' ? foreignKey : '',
              });
            }
          }
        }
      }
    }
    return relationships;
  }

  /**
   * Builds lazy loading methods for relationships.
   * @returns Record of entity names to lazy method definitions.
   */
  private buildLazyMethods(): Record<string, LazyMethod[]> {
    const lazyMethods: Record<string, LazyMethod[]> = {};

    for (const rel of this.relationships) {
      lazyMethods[rel.from] = lazyMethods[rel.from] || [];

      if (rel.type === 'one-to-many') {
        // e.g., personality.chats()
        const singularParent = rel.from.endsWith('s') ? rel.from.slice(0, -1) : rel.from;
        const foreignKeyInChild = `${singularParent}Id`;
        lazyMethods[rel.from].push({
          name: rel.relationshipField,
          type: 'one-to-many',
          childEntityName: rel.to,
          parentEntityName: rel.from,
          fetch: (entity) => (conditions: any = {}) => {
            return this.find(rel.to, { ...conditions, [foreignKeyInChild]: entity.id });
          },
        });
      } else if (rel.type === 'belongs-to') {
        // e.g., chat.personality()
        lazyMethods[rel.from].push({
          name: rel.relationshipField,
          type: 'belongs-to',
          fetch: (entity) => {
            const relatedId = entity[rel.foreignKey];
            return () => (relatedId ? this.get(rel.to, { id: relatedId }) : null);
          },
        });

        // Build inverse relationship (one-to-many)
        // e.g., personality.chats() is the inverse of chat.personality()
        const inverseName = rel.from;
        lazyMethods[rel.to] = lazyMethods[rel.to] || [];

        // Find the corresponding one-to-many relationship defined on the parent
        const parentRel = this.relationships.find(r => r.type === 'one-to-many' && r.from === rel.to && r.to === rel.from);

        // Use the explicitly defined field name for the inverse relationship if it exists, otherwise use the entity name
        const inverseRelationshipField = parentRel ? parentRel.relationshipField : inverseName;

        const singularParent = rel.to.endsWith('s') ? rel.to.slice(0, -1) : rel.to;
        const foreignKeyInChild = `${singularParent}Id`;

        lazyMethods[rel.to].push({
          name: inverseRelationshipField,
          type: 'one-to-many',
          childEntityName: rel.from,
          parentEntityName: rel.to,
          fetch: (entity) => (conditions: any = {}) => {
            return this.find(rel.from, { ...conditions, [foreignKeyInChild]: entity.id });
          },
        });
      }
    }
    return lazyMethods;
  }

  /**
   * Initializes database tables based on schemas.
   */
  private initializeTables(): void {
    for (const [entityName, schema] of Object.entries(this.schemas)) {
      if (!this.schemas[entityName]) {
        throw new Error(`Invalid entity name: ${entityName}`);
      }
      const storableFields = this.getStorableFields(schema);
      let columns = storableFields.map(f => `${f.name} ${this.zodTypeToSqlType(f.type)}`);

      const belongsToRels = this.relationships.filter(
        rel => rel.type === 'belongs-to' && rel.from === entityName
      );
      for (const rel of belongsToRels) {
        columns.push(`${rel.foreignKey} TEXT REFERENCES ${rel.to}(id)`);
      }

      const createTableSql = `CREATE TABLE IF NOT EXISTS ${entityName} (id TEXT PRIMARY KEY, ${columns.join(', ')})`;
      try {
        this.db.run(createTableSql);
      } catch (error) {
        throw new Error(`Failed to create table ${entityName}: ${error.message}`);
      }
    }
  }

  /**
   * Checks if a field is a relationship field.
   * @param schema Zod schema.
   * @param key Field name.
   * @returns True if the field is a relationship.
   */
  private isRelationshipField(schema: z.ZodObject<any>, key: string): boolean {
    let fieldSchema = schema.shape[key];
    if (fieldSchema instanceof z.ZodOptional) {
      fieldSchema = fieldSchema._def.innerType;
    }
    return fieldSchema instanceof z.ZodLazy;
  }

  /**
   * Gets storable fields from a schema, excluding relationships.
   * @param schema Zod schema.
   * @returns Array of field names and types.
   */
  private getStorableFields(schema: z.ZodObject<any>): { name: string; type: ZodType }[] {
    return Object.entries(schema.shape)
      .filter(([key]) => key !== 'id' && !this.isRelationshipField(schema, key))
      .map(([name, type]) => ({ name, type: type as ZodType }));
  }

  /**
   * Maps Zod types to SQLite types.
   * @param zodType Zod type.
   * @returns Corresponding SQLite type.
   */
  private zodTypeToSqlType(zodType: ZodType): string {
    if (zodType instanceof z.ZodString || zodType instanceof z.ZodDate) return 'TEXT';
    if (zodType instanceof z.ZodNumber || zodType instanceof z.ZodBoolean) return 'INTEGER';
    if (zodType._def.typeName === 'ZodInstanceOf' && zodType._def.type === Buffer) return 'BLOB';
    return 'TEXT';
  }

  /**
   * Transforms data for storage (e.g., Date to ISO string).
   * @param data Input data.
   * @returns Transformed data.
   */
  private transformForStorage(data: Record<string, any>): Record<string, any> {
    const transformed: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value instanceof Date) {
        transformed[key] = value.toISOString();
      } else if (typeof value === 'boolean') {
        transformed[key] = value ? 1 : 0;
      } else {
        transformed[key] = value;
      }
    }
    return transformed;
  }

  /**
   * Transforms data from storage (e.g., ISO string to Date).
   * @param row Database row.
   * @param schema Zod schema.
   * @returns Transformed data.
   */
  private transformFromStorage(row: Record<string, any>, schema: z.ZodObject<any>): Record<string, any> {
    const transformed: Record<string, any> = {};
    for (const [key, value] of Object.entries(row)) {
      let fieldSchema = schema.shape[key];
      if (fieldSchema instanceof z.ZodOptional) {
        fieldSchema = fieldSchema._def.innerType;
      }
      if (fieldSchema instanceof z.ZodDefault) {
        fieldSchema = fieldSchema._def.innerType;
      }

      if (fieldSchema instanceof z.ZodDate && typeof value === 'string') {
        transformed[key] = new Date(value);
      } else if (fieldSchema instanceof z.ZodBoolean && typeof value === 'number') {
        transformed[key] = value === 1;
      } else {
        transformed[key] = value;
      }
    }
    return transformed;
  }

  /**
   * Attaches methods (update, delete, relationships) to an entity.
   * @param entityName Entity name.
   * @param entity Entity data.
   * @returns Augmented entity.
   */
  private _attachMethods<T extends Record<string, any>>(entityName: string, entity: T): T {
    const augmentedEntity = entity as any;
    augmentedEntity.update = (data: Partial<Omit<T, 'id'>>) => this.update(entityName, entity.id, data);
    augmentedEntity.delete = () => this.delete(entityName, entity.id);

    const lazyMethodDefs = this.lazyMethods[entityName] || [];
    for (const methodDef of lazyMethodDefs) {
      const fetcher = methodDef.fetch(entity);

      if (methodDef.type === 'one-to-many') {
        const singularParentName = methodDef.parentEntityName!.endsWith('s') ? methodDef.parentEntityName!.slice(0, -1) : methodDef.parentEntityName!;
        const foreignKey = `${singularParentName}Id`;

        // e.g., chat.messages()
        const findRel: any = (conditions: any) => fetcher(conditions); // becomes chat.messages()

        // e.g., chat.messages.push()
        findRel.push = (data: any) => this.insert(methodDef.childEntityName!, { ...data, [foreignKey]: entity.id });

        augmentedEntity[methodDef.name] = findRel;

        // e.g., chat.message(id)
        const singularName = methodDef.childEntityName!.endsWith('s') ? methodDef.childEntityName!.slice(0, -1) : methodDef.childEntityName!;
        augmentedEntity[singularName] = (id: string) => this.get(methodDef.childEntityName!, { id, [foreignKey]: entity.id });

      } else {
        // e.g., chat.personality()
        augmentedEntity[methodDef.name] = fetcher;
      }
    }

    const storableFieldNames = new Set(this.getStorableFields(this.schemas[entityName]).map(f => f.name));

    // Wrap the entity in a proxy to enable reactive updates
    const proxyHandler: ProxyHandler<T> = {
      set: (target: T, prop: string, value: any): boolean => {
        // If the property is a storable data field and the value has changed
        if (storableFieldNames.has(prop) && target[prop] !== value) {
          // Persist the change to the database
          this.update(entityName, target.id, { [prop]: value });
        }

        // Perform the original set operation on the target object
        target[prop] = value;
        return true;
      },
      get: (target: T, prop: string, receiver: any): any => {
        return Reflect.get(target, prop, receiver);
      }
    };

    return new Proxy(augmentedEntity, proxyHandler);
  }
  /**
   * Executes a transaction for atomic operations.
   * @param callback Transaction callback.
   * @returns Result of the callback.
   */
  transaction<T>(callback: () => T): T {
    try {
      this.db.run('BEGIN TRANSACTION');
      const result = callback();
      this.db.run('COMMIT');
      return result;
    } catch (error) {
      this.db.run('ROLLBACK');
      throw new Error(`Transaction failed: ${error.message}`);
    }
  }

  /**
   * Inserts a new entity.
   * @param entityName Entity name.
   * @param data Entity data (excluding ID).
   * @returns Inserted entity.
   */
  insert<T extends Record<string, any>>(entityName: string, data: Omit<T, 'id'>): T {
    try {
      const schema = this.schemas[entityName];
      if (!schema) throw new Error(`Unknown entity: ${entityName}`);
      const id = this.generateId(entityName, data);
      const validatedData = (schema as z.ZodObject<any>).passthrough().parse({ ...data, id }); // Use passthrough to keep foreign keys
      const storableData = Object.fromEntries(
        Object.entries(validatedData).filter(([key]) => !this.isRelationshipField(schema, key))
      );
      const transformedData = this.transformForStorage({ ...storableData, id });
      const columns = Object.keys(transformedData);
      const placeholders = columns.map(() => '?').join(', ');
      const values = Object.values(transformedData);
      const sql = `INSERT INTO ${entityName} (${columns.join(', ')}) VALUES (${placeholders})`;
      this.db.query(sql).run(...values);
      const newEntity = this.get(entityName, { id });
      if (!newEntity) throw new Error('Failed to retrieve entity after insertion');
      this.emit('insert', entityName, newEntity);
      if (this.subscriptions.insert[entityName]) {
        this.subscriptions.insert[entityName].forEach(cb => cb(newEntity));
      }
      return newEntity as T;
    } catch (error) {
      throw new Error(`Failed to insert into ${entityName}: ${error.message}`);
    }
  }

  /**
   * Retrieves a single entity.
   * @param entityName Entity name.
   * @param conditions Query conditions.
   * @param fields Optional fields to select.
   * @returns Entity or null.
   */
  get<T extends Record<string, any>>(
    entityName: string,
    conditions: string | Partial<T>
  ): T | null {
    try {
      if (!this.schemas[entityName]) throw new Error(`Unknown entity: ${entityName}`);
      const queryConditions = typeof conditions === 'string' ? { id: conditions } : conditions;
      if (Object.keys(queryConditions).length === 0) {
        return null;
      }

      const results = this.find(entityName, { ...queryConditions, $limit: 1 });
      return results.length > 0 ? (results[0] as T) : null;
    } catch (error) {
      throw new Error(`Failed to get from ${entityName}: ${error.message}`);
    }
  }

  /**
   * Retrieves multiple entities.
   * @param entityName Entity name.
   * @param conditions Query conditions.
   * @returns Array of entities.
   */
  find<T extends Record<string, any>>(
    entityName: string,
    conditions: Record<string, any> = {}
  ): T[] {
    try {
      if (!this.schemas[entityName]) throw new Error(`Unknown entity: ${entityName}`);
      const { $limit, $offset, $sortBy, ...whereConditions } = conditions;

      const whereClause = Object.keys(whereConditions).length
        ? `WHERE ${Object.keys(whereConditions).map(key => `${key} = ?`).join(' AND ')}`
        : '';

      let orderByClause = '';
      if ($sortBy) {
        const [field, direction = 'ASC'] = ($sortBy as string).split(':');
        if (this.getStorableFields(this.schemas[entityName]).some(f => f.name === field)) {
          orderByClause = `ORDER BY ${field} ${direction.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`;
        }
      }

      const limitClause = $limit ? `LIMIT ${$limit}` : '';
      const offsetClause = $offset ? `OFFSET ${$offset}` : '';

      const sql = `SELECT * FROM ${entityName} ${whereClause} ${orderByClause} ${limitClause} ${offsetClause}`;
      const rows = this.db.query(sql).all(...Object.values(whereConditions));
      return rows.map(row => {
        const entity = this.transformFromStorage(row, this.schemas[entityName]) as T;
        return this._attachMethods(entityName, entity);
      });
    } catch (error) {
      throw new Error(`Failed to find in ${entityName}: ${error.message}`);
    }
  }

  /**
   * Updates an existing entity.
   * @param entityName Entity name.
   * @param id Entity ID.
   * @param data Partial entity data.
   * @returns Updated entity or null.
   */
  update<T extends Record<string, any>>(entityName: string, id: string, data: Partial<Omit<T, 'id'>>): T | null {
    try {
      if (!this.schemas[entityName]) throw new Error(`Unknown entity: ${entityName}`);
      const schema = this.schemas[entityName];
      const validatedData = schema.partial().parse(data);
      const transformedData = this.transformForStorage(validatedData);
      if (Object.keys(transformedData).length === 0) {
        return this.get(entityName, { id } as Partial<T>);
      }
      const setClause = Object.keys(transformedData).map(key => `${key} = ?`).join(', ');
      const values = [...Object.values(transformedData), id];
      const sql = `UPDATE ${entityName} SET ${setClause} WHERE id = ?`;
      this.db.query(sql).run(...values);
      const updatedEntity = this.get(entityName, { id });
      if (updatedEntity) {
        this.emit('update', entityName, updatedEntity);
        if (this.subscriptions.update[entityName]) {
          this.subscriptions.update[entityName].forEach(cb => cb(updatedEntity));
        }
      }
      return updatedEntity as T | null;
    } catch (error) {
      throw new Error(`Failed to update ${entityName}: ${error.message}`);
    }
  }

  /**
   * Inserts or updates an entity based on conditions or ID.
   * @param entityName Entity name.
   * @param data Entity data.
   * @param conditions Optional conditions to find existing entity.
   * @returns Inserted or updated entity.
   */
  upsert<T extends Record<string, any>>(
    entityName: string,
    data: Omit<T, 'id'> & { id?: string },
    conditions: Partial<T> = {}
  ): T {
    try {
      if (!this.schemas[entityName]) throw new Error(`Unknown entity: ${entityName}`);
      const hasId = data.id && typeof data.id === 'string';
      const existing = hasId
        ? this.get(entityName, { id: data.id })
        : Object.keys(conditions).length
          ? this.get(entityName, conditions)
          : null;

      if (existing) {
        const updateData = { ...data };
        delete updateData.id; // Remove ID from update data
        return this.update(entityName, existing.id, updateData) as T;
      } else {
        return this.insert(entityName, data);
      }
    } catch (error) {
      throw new Error(`Failed to upsert in ${entityName}: ${error.message}`);
    }
  }

  /**
   * Deletes an entity.
   * @param entityName Entity name.
   * @param id Entity ID.
   */
  delete(entityName: string, id: string): void {
    try {
      if (!this.schemas[entityName]) throw new Error(`Unknown entity: ${entityName}`);
      const entity = this.get(entityName, { id });
      if (entity) {
        const sql = `DELETE FROM ${entityName} WHERE id = ?`;
        this.db.query(sql).run(id);
        this.emit('delete', entityName, entity);
        if (this.subscriptions.delete[entityName]) {
          this.subscriptions.delete[entityName].forEach(cb => cb(entity));
        }
      }
    } catch (error) {
      throw new Error(`Failed to delete from ${entityName}: ${error.message}`);
    }
  }

  /**
   * Subscribes to entity events.
   * @param event Event type ('insert', 'update', 'delete').
   * @param entityName Entity name.
   * @param callback Callback function.
   */
  subscribe(event: 'insert' | 'update' | 'delete', entityName: string, callback: (data: any) => void): void {
    if (!this.schemas[entityName]) throw new Error(`Unknown entity: ${entityName}`);
    this.subscriptions[event][entityName] = this.subscriptions[event][entityName] || [];
    this.subscriptions[event][entityName].push(callback);
  }
}

export { MyDatabase, z };