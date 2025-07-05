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
  push: (data: EntityData<S>) => AugmentedEntity<S>; // Alias for insert
};

// Type for a single entity accessor (e.g., db.students)
type EntityAccessor<S extends z.ZodObject<any>> = {
  insert: (data: EntityData<S>) => AugmentedEntity<S>;
  get: (conditions: string | Partial<InferSchema<S>>) => AugmentedEntity<S> | null;
  find: (conditions?: Record<string, any>) => AugmentedEntity<S>[];
  update: (id: string, data: Partial<EntityData<S>>) => AugmentedEntity<S> | null;
  upsert: (conditions?: Partial<InferSchema<S>>, data: Partial<InferSchema<S>>) => AugmentedEntity<S>;
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
            push: (data: any) => this.insert(rel.to, { ...data, [foreignKeyInChild]: entity.id }),
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
              push: (data: any) => this.insert(rel.from, { ...data, [foreignKeyInChild]: entity.id }),
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

  private _attachMethods<T extends Record<string, any>>(entityName: string, entity: T, includedData?: Record<string, any>): AugmentedEntity<any> {
    const augmentedEntity = entity as any;
    augmentedEntity.update = (data: Partial<Omit<T, 'id'>>) => this.update(entityName, entity.id, data);
    augmentedEntity.delete = () => this.delete(entityName, entity.id);

    const lazyMethodDefs = this.lazyMethods[entityName] || [];
    for (const methodDef of lazyMethodDefs) {
      // Check if we have included data for this relationship
      if (includedData && includedData[methodDef.name] !== undefined) {
        if (methodDef.type === 'belongs-to') {
          // For belongs-to relationships, attach the included entity directly
          const includedEntity = includedData[methodDef.name];
          augmentedEntity[methodDef.name] = () => includedEntity;
        } else if (methodDef.type === 'one-to-many') {
          // For one-to-many relationships, create a manager that uses included data for find()
          const includedEntities = includedData[methodDef.name] || [];
          const singularParent = methodDef.parentEntityName!.endsWith('s') ? methodDef.parentEntityName!.slice(0, -1) : methodDef.parentEntityName!;
          const foreignKeyInChild = `${singularParent}Id`;
          
          augmentedEntity[methodDef.name] = {
            insert: (data: any) => this.insert(methodDef.childEntityName!, { ...data, [foreignKeyInChild]: entity.id }),
            get: (conditions: any) => {
              const queryConditions = typeof conditions === 'string' ? { id: conditions } : conditions;
              return this.get(methodDef.childEntityName!, { ...queryConditions, [foreignKeyInChild]: entity.id });
            },
            find: (conditions: any = {}) => {
              // If no specific conditions and we have included data, return it
              if (Object.keys(conditions).length === 0) {
                return includedEntities;
              }
              // Otherwise, fall back to database query
              return this.find(methodDef.childEntityName!, { ...conditions, [foreignKeyInChild]: entity.id });
            },
            update: (id: string, data: any) => this.update(methodDef.childEntityName!, id, data),
            upsert: (conditions: any = {}, data: any = {}) => this.upsert(methodDef.childEntityName!, { ...data, [foreignKeyInChild]: entity.id }, { ...conditions, [foreignKeyInChild]: entity.id }),
            delete: (id?: string) => {
              if (id) {
                this.delete(methodDef.childEntityName!, id);
              } else {
                // Delete all related entities
                const relatedEntities = this.find(methodDef.childEntityName!, { [foreignKeyInChild]: entity.id });
                relatedEntities.forEach(e => this.delete(methodDef.childEntityName!, e.id));
              }
            },
            subscribe: (event: any, callback: any) => this.subscribe(event, methodDef.childEntityName!, callback),
            push: (data: any) => this.insert(methodDef.childEntityName!, { ...data, [foreignKeyInChild]: entity.id }),
          };
          
          const singularName = methodDef.childEntityName!.endsWith('s') ? methodDef.childEntityName!.slice(0, -1) : methodDef.childEntityName!;
          augmentedEntity[singularName] = (id: string) => this.get(methodDef.childEntityName!, { id, [foreignKeyInChild]: entity.id });
        }
      } else {
        // Standard lazy loading behavior
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
    }

    const storableFieldNames = new Set(this.getStorableFields(this.schemas[entityName]).map(f => f.name));
    const proxyHandler: ProxyHandler<T> = {
      set: (target: T, prop: string, value: any): boolean => {
        if (storableFieldNames.has(prop) && target[prop] !== value) {
          this.update(entityName, target.id, { [prop]: value });
        }
        target[prop] = value;
        return true;
      },
      get: (target: T, prop: string, receiver: any): any => Reflect.get(target, prop, receiver),
    };

    return new Proxy(augmentedEntity, proxyHandler);
  }

  // Helper method to build JOIN queries for included relationships
  private buildJoinQuery(entityName: string, conditions: Record<string, any>, includeFields: string[]): {
    sql: string;
    values: any[];
    joinedTables: { alias: string; entityName: string; relationship: Relationship }[];
  } {
    const { $limit, $offset, $sortBy, $include, ...whereConditions } = conditions;
    
    let sql = `SELECT ${entityName}.*`;
    const joinedTables: { alias: string; entityName: string; relationship: Relationship }[] = [];
    const joinClauses: string[] = [];

    // Add JOINs for belongs-to relationships
    for (const includeField of includeFields) {
      const relationship = this.relationships.find(
        rel => rel.from === entityName && rel.relationshipField === includeField && rel.type === 'belongs-to'
      );

      if (relationship) {
        const alias = `${includeField}_tbl`;
        joinedTables.push({ alias, entityName: relationship.to, relationship });
        
        // Add columns from joined table with alias prefix
        const joinedSchema = this.schemas[relationship.to];
        const joinedFields = ['id', ...this.getStorableFields(joinedSchema).map(f => f.name)];
        const aliasedColumns = joinedFields.map(field => `${alias}.${field} AS ${alias}_${field}`);
        sql += `, ${aliasedColumns.join(', ')}`;
        
        // Add LEFT JOIN clause
        joinClauses.push(`LEFT JOIN ${relationship.to} ${alias} ON ${entityName}.${relationship.foreignKey} = ${alias}.id`);
      }
    }

    sql += ` FROM ${entityName}`;
    if (joinClauses.length > 0) {
      sql += ` ${joinClauses.join(' ')}`;
    }

    // Add WHERE clause
    const whereClause = Object.keys(whereConditions).length 
      ? `WHERE ${Object.keys(whereConditions).map(key => `${entityName}.${key} = ?`).join(' AND ')}` 
      : '';
    if (whereClause) sql += ` ${whereClause}`;

    // Add ORDER BY clause
    if ($sortBy) {
      const [field, direction = 'ASC'] = ($sortBy as string).split(':');
      sql += ` ORDER BY ${entityName}.${field} ${direction.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`;
    }

    // Add LIMIT and OFFSET
    if ($limit) sql += ` LIMIT ${$limit}`;
    if ($offset) sql += ` OFFSET ${$offset}`;

    return {
      sql,
      values: Object.values(whereConditions),
      joinedTables
    };
  }

  // Helper method to parse JOIN query results
  private parseJoinResults(rows: any[], entityName: string, joinedTables: { alias: string; entityName: string; relationship: Relationship }[]): {
    entities: any[];
    includedData: Record<string, any>[];
  } {
    const entities: any[] = [];
    const includedDataArray: Record<string, any>[] = [];

    for (const row of rows) {
      // Extract main entity data
      const mainEntity: Record<string, any> = {};
      const mainSchema = this.schemas[entityName];
      const mainFields = ['id', ...this.getStorableFields(mainSchema).map(f => f.name)];
      
      for (const field of mainFields) {
        if (row[field] !== undefined) {
          mainEntity[field] = row[field];
        }
      }

      // Extract included relationship data
      const includedData: Record<string, any> = {};
      for (const { alias, entityName: joinedEntityName, relationship } of joinedTables) {
        const joinedEntity: Record<string, any> = {};
        const joinedSchema = this.schemas[joinedEntityName];
        const joinedFields = ['id', ...this.getStorableFields(joinedSchema).map(f => f.name)];
        
        let hasData = false;
        for (const field of joinedFields) {
          const aliasedFieldName = `${alias}_${field}`;
          if (row[aliasedFieldName] !== undefined && row[aliasedFieldName] !== null) {
            joinedEntity[field] = row[aliasedFieldName];
            hasData = true;
          }
        }

        if (hasData) {
          const transformedJoinedEntity = this.transformFromStorage(joinedEntity, joinedSchema);
          const augmentedJoinedEntity = this._attachMethods(joinedEntityName, transformedJoinedEntity);
          includedData[relationship.relationshipField] = augmentedJoinedEntity;
        }
      }

      entities.push(this.transformFromStorage(mainEntity, mainSchema));
      includedDataArray.push(includedData);
    }

    return { entities, includedData: includedDataArray };
  }

  // Helper method to handle one-to-many relationships separately (these require separate queries but can be optimized)
  private loadOneToManyIncludes(entityName: string, entities: any[], includeFields: string[]): Record<string, any>[] {
    const includedDataArray: Record<string, any>[] = entities.map(() => ({}));

    for (const includeField of includeFields) {
      const relationship = this.relationships.find(
        rel => rel.from === entityName && rel.relationshipField === includeField && rel.type === 'one-to-many'
      );

      if (relationship) {
        // Get all entity IDs
        const entityIds = entities.map(e => e.id);
        if (entityIds.length === 0) continue;

        const singularParent = relationship.from.endsWith('s') ? relationship.from.slice(0, -1) : relationship.from;
        const foreignKeyInChild = `${singularParent}Id`;

        // Single query to get all related entities
        const placeholders = entityIds.map(() => '?').join(', ');
        const sql = `SELECT * FROM ${relationship.to} WHERE ${foreignKeyInChild} IN (${placeholders})`;
        const relatedRows = this.db.query(sql).all(...entityIds);

        // Group related entities by parent ID
        const relatedByParent: Record<string, any[]> = {};
        for (const row of relatedRows) {
          const parentId = row[foreignKeyInChild];
          if (!relatedByParent[parentId]) {
            relatedByParent[parentId] = [];
          }
          const transformedEntity = this.transformFromStorage(row, this.schemas[relationship.to]);
          const augmentedEntity = this._attachMethods(relationship.to, transformedEntity);
          relatedByParent[parentId].push(augmentedEntity);
        }

        // Assign to each entity's included data
        entities.forEach((entity, index) => {
          includedDataArray[index][includeField] = relatedByParent[entity.id] || [];
        });
      }
    }

    return includedDataArray;
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
    const { $include, ...otherConditions } = conditions;
    
    // Parse $include parameter
    const includeFields: string[] = [];
    if ($include) {
      if (typeof $include === 'string') {
        includeFields.push($include);
      } else if (Array.isArray($include)) {
        includeFields.push(...$include);
      }
    }

    if (includeFields.length === 0) {
      // No includes - use simple query
      const { $limit, $offset, $sortBy, ...whereConditions } = otherConditions;
      const whereClause = Object.keys(whereConditions).length ? `WHERE ${Object.keys(whereConditions).map(key => `${key} = ?`).join(' AND ')}` : '';
      let orderByClause = '';
      if ($sortBy) {
        const [field, direction = 'ASC'] = ($sortBy as string).split(':');
        orderByClause = `ORDER BY ${field} ${direction.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`;
      }
      const limitClause = $limit ? `LIMIT ${$limit}` : '';
      const offsetClause = $offset ? `OFFSET ${$offset}` : '';
      const sql = `SELECT * FROM ${entityName} ${whereClause} ${orderByClause} ${limitClause} ${offsetClause}`;
      const rows = this.db.query(sql).all(...Object.values(whereConditions));
      
      return rows.map(row => {
        const entity = this.transformFromStorage(row as any, this.schemas[entityName]) as T;
        return this._attachMethods(entityName, entity);
      });
    }

    // Separate belongs-to and one-to-many includes
    const belongsToIncludes = includeFields.filter(field => {
      const rel = this.relationships.find(r => r.from === entityName && r.relationshipField === field);
      return rel?.type === 'belongs-to';
    });

    const oneToManyIncludes = includeFields.filter(field => {
      const rel = this.relationships.find(r => r.from === entityName && r.relationshipField === field);
      return rel?.type === 'one-to-many';
    });

    let entities: any[];
    let includedDataArray: Record<string, any>[];

    if (belongsToIncludes.length > 0) {
      // Use JOIN query for belongs-to relationships
      const { sql, values, joinedTables } = this.buildJoinQuery(entityName, otherConditions, belongsToIncludes);
      console.log(`[Performance] Using JOIN query: ${sql}`);
      const rows = this.db.query(sql).all(...values);
      const result = this.parseJoinResults(rows, entityName, joinedTables);
      entities = result.entities;
      includedDataArray = result.includedData;
    } else {
      // No belongs-to includes, use simple query
      const { $limit, $offset, $sortBy, ...whereConditions } = otherConditions;
      const whereClause = Object.keys(whereConditions).length ? `WHERE ${Object.keys(whereConditions).map(key => `${key} = ?`).join(' AND ')}` : '';
      let orderByClause = '';
      if ($sortBy) {
        const [field, direction = 'ASC'] = ($sortBy as string).split(':');
        orderByClause = `ORDER BY ${field} ${direction.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`;
      }
      const limitClause = $limit ? `LIMIT ${$limit}` : '';
      const offsetClause = $offset ? `OFFSET ${$offset}` : '';
      const sql = `SELECT * FROM ${entityName} ${whereClause} ${orderByClause} ${limitClause} ${offsetClause}`;
      const rows = this.db.query(sql).all(...Object.values(whereConditions));
      entities = rows.map(row => this.transformFromStorage(row as any, this.schemas[entityName]) as T);
      includedDataArray = entities.map(() => ({}));
    }

    // Handle one-to-many includes with optimized batch queries
    if (oneToManyIncludes.length > 0) {
      console.log(`[Performance] Using batch query for one-to-many: ${oneToManyIncludes.join(', ')}`);
      const oneToManyData = this.loadOneToManyIncludes(entityName, entities, oneToManyIncludes);
      // Merge one-to-many data with belongs-to data
      includedDataArray = includedDataArray.map((includedData, index) => ({
        ...includedData,
        ...oneToManyData[index]
      }));
    }
    
    return entities.map((entity, index) => {
      return this._attachMethods(entityName, entity, includedDataArray[index]);
    });
  }

  private update<T extends Record<string, any>>(entityName: string, id: string, data: Partial<Omit<T, 'id'>>): AugmentedEntity<any> | null {
    const schema = this.schemas[entityName];
    const validatedData = schema.partial().parse(data);
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
    const existing = hasId ? this.get(entityName, { id: data.id } as Partial<T>) : Object.keys(conditions).length > 0 ? this.get(entityName, conditions) : null;
    if (existing) {
      const updateData = { ...data };
      delete updateData.id;
      return this.update(entityName, existing.id, updateData) as AugmentedEntity<any>;
    } else {
      // Merge conditions into data for insert - this fixes the courseId issue
      const insertData = { ...conditions, ...data };
      delete insertData.id; // Remove id if it exists since insert generates its own
      return this.insert(entityName, insertData);
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