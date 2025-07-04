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
  relationshipField: string;
  foreignKey: string;
};

type LazyMethod<T = any, R = any> = {
  name: string;
  type: Relationship['type'];
  fetch: (entity: T) => R;
  childEntityName?: string;
  parentEntityName?: string;
};

// --- Type Helpers for Stronger Safety ---
type InferSchema<S extends z.ZodObject<any>> = z.infer<S>;

// Type for data used in `insert` or `upsert` calls (schema shape minus generated ID)
type EntityData<S extends z.ZodObject<any>> = Omit<InferSchema<S>, 'id'>;

// Type for the object returned from the database, including its methods
type AugmentedEntity<S extends z.ZodObject<any>> = InferSchema<S> & {
  update: (data: Partial<EntityData<S>>) => AugmentedEntity<S> | null;
  delete: () => void;
  // Dynamic relationship fields are added at runtime.
  [key: string]: any;
};

// Type for a one-to-many relationship manager (e.g., student.enrollments)
type OneToManyRelationship<S extends z.ZodObject<any>> = {
  insert: (data: EntityData<S>) => AugmentedEntity<S>;
  get: (conditions: string | Partial<InferSchema<S>>) => AugmentedEntity<S> | null;
  find: (conditions?: Record<string, any>) => AugmentedEntity<S>[];
  update: (id: string, data: Partial<EntityData<S>>) => AugmentedEntity<S> | null;
  upsert: (conditions?: Partial<InferSchema<S>>, data?: Partial<InferSchema<S>>) => AugmentedEntity<S>;
  delete: (id?: string) => void; // If no id provided, delete all related entities
  subscribe: (event: 'insert' | 'update' | 'delete', callback: (data: AugmentedEntity<S>) => void) => void;
};

// Type for a single entity accessor (e.g., db.students)
type EntityAccessor<S extends z.ZodObject<any>> = {
  insert: (data: EntityData<S>) => AugmentedEntity<S>;
  get: (conditions: string | Partial<InferSchema<S>>) => AugmentedEntity<S> | null;
  find: (conditions?: Record<string, any>) => AugmentedEntity<S>[];
  update: (id: string, data: Partial<EntityData<S>>) => AugmentedEntity<S> | null;
  upsert: (conditions?: Partial<InferSchema<S>>, data?: Partial<InferSchema<S>>) => AugmentedEntity<S>;
  delete: (id: string) => void;
  subscribe: (event: 'insert' | 'update' | 'delete', callback: (data: AugmentedEntity<S>) => void) => void;
};

// This will be the main, typed entry point for all database operations
type TypedAccessors<T extends SchemaMap> = {
  [K in keyof T]: EntityAccessor<T[K]>;
};

/**
 * A custom SQLite database wrapper with schema validation, relationships, and event handling.
 */
class SatiDB<Schemas extends SchemaMap> extends EventEmitter {
  private db: Database;
  private schemas: Schemas;
  private relationships: Relationship[];
  private lazyMethods: Record<string, LazyMethod[]>;
  private subscriptions: Record<'insert' | 'update' | 'delete', Record<string, ((data: any) => void)[]>>;

  constructor(dbFile: string, schemas: Schemas) {
    super();
    this.db = new Database(dbFile);
    this.db.run('PRAGMA foreign_keys = ON');
    this.schemas = schemas;
    this.subscriptions = { insert: {}, update: {}, delete: {} };
    this.relationships = this.parseRelationships(schemas);
    this.lazyMethods = this.buildLazyMethods();
    this.initializeTables();
    
    // Build and merge the type-safe accessors directly onto the instance
    Object.keys(schemas).forEach(entityName => {
      const key = entityName as keyof Schemas;
      const accessor: EntityAccessor<Schemas[typeof key]> = {
        insert: (data) => this.insert(entityName, data),
        get: (conditions) => this.get(entityName, conditions),
        find: (conditions) => this.find(entityName, conditions),
        update: (id, data) => this.update(entityName, id, data),
        upsert: (conditions, data) => this.upsert(entityName, data, conditions),
        delete: (id) => this.delete(entityName, id),
        subscribe: (event, callback) => this.subscribe(event, entityName, callback),
      };
      // Dynamically assign the accessor to `this`
      (this as any)[key] = accessor;
    });
  }

  private generateId(entityName: string, data: Record<string, any>): string {
    const schema = this.schemas[entityName];
    const hashableData = Object.fromEntries(
      Object.entries(data).filter(([key]) => !this.isRelationshipField(schema, key))
    );
    const hash = createHash('sha256').update(JSON.stringify(hashableData)).digest('hex');
    return hash.substring(0, 16);
  }

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

  private buildLazyMethods(): Record<string, LazyMethod[]> {
    const lazyMethods: Record<string, LazyMethod[]> = {};

    for (const rel of this.relationships) {
      lazyMethods[rel.from] = lazyMethods[rel.from] || [];

      if (rel.type === 'one-to-many') {
        const singularParent = rel.from.endsWith('s') ? rel.from.slice(0, -1) : rel.from;
        const foreignKeyInChild = `${singularParent}Id`;
        lazyMethods[rel.from].push({
          name: rel.relationshipField,
          type: 'one-to-many',
          childEntityName: rel.to,
          parentEntityName: rel.from,
          fetch: (entity) => ({
            insert: (data: any) => this.insert(rel.to, { ...data, [foreignKeyInChild]: entity.id }),
            get: (conditions: any) => {
              const queryConditions = typeof conditions === 'string' ? { id: conditions } : conditions;
              return this.get(rel.to, { ...queryConditions, [foreignKeyInChild]: entity.id });
            },
            find: (conditions: any = {}) => this.find(rel.to, { ...conditions, [foreignKeyInChild]: entity.id }),
            update: (id: string, data: any) => this.update(rel.to, id, data),
            upsert: (conditions: any = {}, data: any = {}) => this.upsert(rel.to, { ...data, [foreignKeyInChild]: entity.id }, { ...conditions, [foreignKeyInChild]: entity.id }),
            delete: (id?: string) => {
              if (id) {
                this.delete(rel.to, id);
              } else {
                // Delete all related entities
                const relatedEntities = this.find(rel.to, { [foreignKeyInChild]: entity.id });
                relatedEntities.forEach(e => this.delete(rel.to, e.id));
              }
            },
            subscribe: (event: any, callback: any) => this.subscribe(event, rel.to, callback),
          }),
        });
      } else if (rel.type === 'belongs-to') {
        lazyMethods[rel.from].push({
          name: rel.relationshipField,
          type: 'belongs-to',
          fetch: (entity) => {
            const relatedId = entity[rel.foreignKey];
            return () => (relatedId ? this.get(rel.to, { id: relatedId }) : null);
          },
        });

        const inverseName = rel.from;
        lazyMethods[rel.to] = lazyMethods[rel.to] || [];
        const parentRel = this.relationships.find(r => r.type === 'one-to-many' && r.from === rel.to && r.to === rel.from);
        const inverseRelationshipField = parentRel ? parentRel.relationshipField : inverseName;
        const singularParent = rel.to.endsWith('s') ? rel.to.slice(0, -1) : rel.to;
        const foreignKeyInChild = `${singularParent}Id`;

        if (!lazyMethods[rel.to].some(m => m.name === inverseRelationshipField)) {
          lazyMethods[rel.to].push({
            name: inverseRelationshipField,
            type: 'one-to-many',
            childEntityName: rel.from,
            parentEntityName: rel.to,
            fetch: (entity) => ({
              insert: (data: any) => this.insert(rel.from, { ...data, [foreignKeyInChild]: entity.id }),
              get: (conditions: any) => {
                const queryConditions = typeof conditions === 'string' ? { id: conditions } : conditions;
                return this.get(rel.from, { ...queryConditions, [foreignKeyInChild]: entity.id });
              },
              find: (conditions: any = {}) => this.find(rel.from, { ...conditions, [foreignKeyInChild]: entity.id }),
              update: (id: string, data: any) => this.update(rel.from, id, data),
              upsert: (conditions: any = {}, data: any = {}) => this.upsert(rel.from, { ...data, [foreignKeyInChild]: entity.id }, { ...conditions, [foreignKeyInChild]: entity.id }),
              delete: (id?: string) => {
                if (id) {
                  this.delete(rel.from, id);
                } else {
                  // Delete all related entities
                  const relatedEntities = this.find(rel.from, { [foreignKeyInChild]: entity.id });
                  relatedEntities.forEach(e => this.delete(rel.from, e.id));
                }
              },
              subscribe: (event: any, callback: any) => this.subscribe(event, rel.from, callback),
            }),
          });
        }
      }
    }
    return lazyMethods;
  }

  private initializeTables(): void {
    for (const [entityName, schema] of Object.entries(this.schemas)) {
      const storableFields = this.getStorableFields(schema);
      let columns = storableFields.map(f => `${f.name} ${this.zodTypeToSqlType(f.type)}`);

      const belongsToRels = this.relationships.filter(
        rel => rel.type === 'belongs-to' && rel.from === entityName
      );
      for (const rel of belongsToRels) {
        columns.push(`${rel.foreignKey} TEXT REFERENCES ${rel.to}(id) ON DELETE SET NULL`);
      }

      const createTableSql = `CREATE TABLE IF NOT EXISTS ${entityName} (id TEXT PRIMARY KEY, ${columns.join(', ')})`;
      this.db.run(createTableSql);
    }
  }

  private isRelationshipField(schema: z.ZodObject<any>, key: string): boolean {
    let fieldSchema = schema.shape[key];
    if (fieldSchema instanceof z.ZodOptional) {
      fieldSchema = fieldSchema._def.innerType;
    }
    return fieldSchema instanceof z.ZodLazy;
  }

  private getStorableFields(schema: z.ZodObject<any>): { name: string; type: ZodType }[] {
    return Object.entries(schema.shape)
      .filter(([key]) => key !== 'id' && !this.isRelationshipField(schema, key))
      .map(([name, type]) => ({ name, type: type as ZodType }));
  }

  private zodTypeToSqlType(zodType: ZodType): string {
    if (zodType instanceof z.ZodString || zodType instanceof z.ZodDate) return 'TEXT';
    if (zodType instanceof z.ZodNumber || zodType instanceof z.ZodBoolean) return 'INTEGER';
    if (zodType._def.typeName === 'ZodInstanceOf' && zodType._def.type === Buffer) return 'BLOB';
    return 'TEXT';
  }

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

  private transformFromStorage(row: Record<string, any>, schema: z.ZodObject<any>): Record<string, any> {
    const transformed: Record<string, any> = {};
    for (const [key, value] of Object.entries(row)) {
      let fieldSchema = schema.shape[key];
      if (!fieldSchema) continue; // Skip fields not in schema (like foreign keys)
      
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
  
  private _attachMethods<T extends Record<string, any>>(entityName: string, entity: T, includedRelations: string[] = []): AugmentedEntity<any> {
    const augmentedEntity = { ...entity } as any;
    augmentedEntity.update = (data: Partial<Omit<T, 'id'>>) => this.update(entityName, entity.id, data);
    augmentedEntity.delete = () => this.delete(entityName, entity.id);

    const lazyMethodDefs = this.lazyMethods[entityName] || [];
    for (const methodDef of lazyMethodDefs) {
        // If the relation was eagerly loaded via $include, don't attach the lazy method for it.
        if (includedRelations.includes(methodDef.name)) {
            // Also, ensure the lazy function isn't callable.
            augmentedEntity[methodDef.name] = entity[methodDef.name];
            continue;
        }

        const fetcher = methodDef.fetch(entity);
        if (methodDef.type === 'one-to-many') {
            augmentedEntity[methodDef.name] = fetcher; // Assigns the full CRUD manager
            const singularName = methodDef.childEntityName!.endsWith('s') ? methodDef.childEntityName!.slice(0, -1) : methodDef.childEntityName!;
            const singularParentName = methodDef.parentEntityName!.endsWith('s') ? methodDef.parentEntityName!.slice(0, -1) : methodDef.parentEntityName!;
            const foreignKey = `${singularParentName}Id`;
            augmentedEntity[singularName] = (id: string) => this.get(methodDef.childEntityName!, { id, [foreignKey]: entity.id });
        } else {
            augmentedEntity[methodDef.name] = fetcher; // Assigns the () => get(...) function
        }
    }

    const storableFieldNames = new Set(this.getStorableFields(this.schemas[entityName]).map(f => f.name));
    const proxyHandler: ProxyHandler<any> = {
      set: (target: T, prop: string, value: any): boolean => {
          if (storableFieldNames.has(prop) && target[prop] !== value) {
              this.update(entityName, target.id, { [prop]: value });
          }
          target[prop] = value;
          return true;
      },
      get: (target: T, prop: string, receiver: any): any => {
        // For included relations, the data is already on the target.
        if (includedRelations.includes(prop) || typeof target[prop] !== 'function') {
            return Reflect.get(target, prop, receiver);
        }
        
        // For lazy-loaded relations, the function is on the target.
        const lazyMethod = lazyMethodDefs.find(m => m.name === prop);
        if (lazyMethod) {
            return lazyMethod.fetch(target)
        }
        
        return Reflect.get(target, prop, receiver);
      },
    };

    return new Proxy(augmentedEntity, proxyHandler);
}

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

  private insert<T extends Record<string, any>>(entityName: string, data: Omit<T, 'id'>): AugmentedEntity<any> {
    const schema = this.schemas[entityName];
    const id = this.generateId(entityName, data);
    const validatedData = schema.passthrough().parse({ ...data, id });
    const storableData = Object.fromEntries(
      Object.entries(validatedData).filter(([key]) => !this.isRelationshipField(schema, key))
    );
    const transformedData = this.transformForStorage({ ...storableData, id });
    const columns = Object.keys(transformedData);
    const placeholders = columns.map(() => '?').join(', ');
    const values = Object.values(transformedData);
    const sql = `INSERT INTO ${entityName} (${columns.join(', ')}) VALUES (${placeholders})`;
    this.db.query(sql).run(...values);
    const newEntity = this.get(entityName, { id } as Partial<T>);
    if (!newEntity) throw new Error('Failed to retrieve entity after insertion');
    this.emit('insert', entityName, newEntity);
    if (this.subscriptions.insert[entityName]) {
      this.subscriptions.insert[entityName].forEach(cb => cb(newEntity));
    }
    return newEntity;
  }

  private get<T extends Record<string, any>>(entityName: string, conditions: string | Partial<T>): AugmentedEntity<any> | null {
    const queryConditions = typeof conditions === 'string' ? { id: conditions } : conditions;
    if (Object.keys(queryConditions).length === 0) return null;
    const results = this.find(entityName, { ...queryConditions, $limit: 1 });
    return results.length > 0 ? results[0] : null;
  }

  private find<T extends Record<string, any>>(entityName: string, conditions: Record<string, any> = {}): AugmentedEntity<any>[] {
    const { $limit, $offset, $sortBy, $include, ...whereConditions } = conditions;

    const includes = Array.isArray($include) ? $include : ($include ? [$include] : []);
    let selectClause = `SELECT DISTINCT ${entityName}.*`;
    let joinClause = '';

    for (const includeField of includes) {
        const rel = this.relationships.find(r => r.from === entityName && r.relationshipField === includeField);
        if (rel && rel.type === 'belongs-to') {
            const joinTable = rel.to;
            const joinTableSchema = this.schemas[joinTable];
            if (!joinTableSchema) continue;

            const joinTableFields = Object.keys(joinTableSchema.shape);
            for (const field of joinTableFields) {
                selectClause += `, ${joinTable}.${field} as ${includeField}__${field}`;
            }
            joinClause += ` LEFT JOIN ${joinTable} ON ${entityName}.${rel.foreignKey} = ${joinTable}.id`;
        }
    }

    const whereClause = Object.keys(whereConditions).length
        ? `WHERE ${Object.keys(whereConditions).map(key => `${entityName}.${key} = ?`).join(' AND ')}`
        : '';

    let orderByClause = '';
    if ($sortBy) {
        const [field, direction = 'ASC'] = ($sortBy as string).split(':');
        orderByClause = `ORDER BY ${entityName}.${field} ${direction.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`;
    }
    const limitClause = $limit ? `LIMIT ${$limit}` : '';
    const offsetClause = $offset ? `OFFSET ${$offset}` : '';
    const sql = `${selectClause} FROM ${entityName} ${joinClause} ${whereClause} ${orderByClause} ${limitClause} ${offsetClause}`;

    const rows = this.db.query(sql).all(...Object.values(whereConditions));

    return rows.map(row => {
        const mainEntityData: Record<string, any> = {};
        const nestedObjects: Record<string, Record<string, any>> = {};

        for (const [key, value] of Object.entries(row as object)) {
            if (key.includes('__')) {
                const [relationName, fieldName] = key.split('__');
                if (!nestedObjects[relationName]) nestedObjects[relationName] = {};
                nestedObjects[relationName][fieldName] = value;
            } else {
                mainEntityData[key] = value;
            }
        }
        
        const baseEntityWithForeignKeys = { ...mainEntityData };
        const entity = this.transformFromStorage(mainEntityData, this.schemas[entityName]);

        for (const [relationName, nestedData] of Object.entries(nestedObjects)) {
            const rel = this.relationships.find(r => r.from === entityName && r.relationshipField === relationName);
            if (rel) {
                if (nestedData.id === null) {
                    entity[relationName] = null;
                } else {
                    const relatedSchema = this.schemas[rel.to];
                    const transformedNested = this.transformFromStorage(nestedData, relatedSchema);
                    entity[relationName] = this._attachMethods(rel.to, { ...transformedNested, ...nestedData });
                }
            }
        }
        return this._attachMethods(entityName, {...entity, ...baseEntityWithForeignKeys }, includes);
    });
}

  private update<T extends Record<string, any>>(entityName: string, id: string, data: Partial<Omit<T, 'id'>>): AugmentedEntity<any> | null {
    const schema = this.schemas[entityName];
    const validatedData = schema.partial().passthrough().parse(data);
    const transformedData = this.transformForStorage(validatedData);
    if (Object.keys(transformedData).length === 0) return this.get(entityName, { id } as Partial<T>);
    const setClause = Object.keys(transformedData).map(key => `${key} = ?`).join(', ');
    const values = [...Object.values(transformedData), id];
    const sql = `UPDATE ${entityName} SET ${setClause} WHERE id = ?`;
    this.db.query(sql).run(...values);
    const updatedEntity = this.get(entityName, { id } as Partial<T>);
    if (updatedEntity) {
      this.emit('update', entityName, updatedEntity);
      if (this.subscriptions.update[entityName]) {
        this.subscriptions.update[entityName].forEach(cb => cb(updatedEntity));
      }
    }
    return updatedEntity;
  }

  private upsert<T extends Record<string, any>>(entityName: string, data: Omit<T, 'id'> & { id?: string }, conditions: Partial<T> = {}): AugmentedEntity<any> {
    const hasId = data.id && typeof data.id === 'string';
    const searchConditions = hasId ? { id: data.id } : conditions;
    const existing = Object.keys(searchConditions).length > 0 ? this.get(entityName, searchConditions as Partial<T>) : null;

    if (existing) {
        const updateData = { ...data };
        delete updateData.id; 
        return this.update(entityName, existing.id, updateData) as AugmentedEntity<any>;
    } else {
        // FIX: Merge conditions and data to ensure all fields are present for insertion.
        const insertData = { ...conditions, ...data };
        delete insertData.id;
        return this.insert(entityName, insertData as Omit<T, 'id'>);
    }
}

  private delete(entityName: string, id: string): void {
    const entity = this.get(entityName, { id });
    if (entity) {
      const sql = `DELETE FROM ${entityName} WHERE id = ?`;
      this.db.query(sql).run(id);
      this.emit('delete', entityName, entity);
      if (this.subscriptions.delete[entityName]) {
        this.subscriptions.delete[entityName].forEach(cb => cb(entity));
      }
    }
  }

  private subscribe(event: 'insert' | 'update' | 'delete', entityName: string, callback: (data: any) => void): void {
    this.subscriptions[event][entityName] = this.subscriptions[event][entityName] || [];
    this.subscriptions[event][entityName].push(callback);
  }
}

// To properly type the instance, we export a type that merges the class and the dynamic accessors
export type DB<S extends SchemaMap> = SatiDB<S> & TypedAccessors<S>;
export { SatiDB, z };