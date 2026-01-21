import { Database } from 'bun:sqlite';
import { EventEmitter } from 'events';
import { z } from 'zod';

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

type EntityData<S extends z.ZodObject<any>> = Omit<InferSchema<S>, 'id'>;

type AugmentedEntity<S extends z.ZodObject<any>> = InferSchema<S> & {
  update: (data: Partial<EntityData<S>>) => AugmentedEntity<S> | null;
  delete: () => void;
  [key: string]: any;
};

type OneToManyRelationship<S extends z.ZodObject<any>> = {
  insert: (data: EntityData<S>) => AugmentedEntity<S>;
  get: (conditions: number | Partial<InferSchema<S>>) => AugmentedEntity<S> | null;
  findOne: (conditions: Record<string, any>) => AugmentedEntity<S> | null;
  find: (conditions?: Record<string, any>) => AugmentedEntity<S>[];
  update: ((id: number, data: Partial<EntityData<S>>) => AugmentedEntity<S> | null) & ((filter: Partial<InferSchema<S>>, data: Partial<EntityData<S>>) => AugmentedEntity<S> | null);
  upsert: (conditions?: Partial<InferSchema<S>>, data?: Partial<InferSchema<S>>) => AugmentedEntity<S>;
  delete: (id?: number) => void;
  subscribe: (event: 'insert' | 'update' | 'delete', callback: (data: AugmentedEntity<S>) => void) => void;
  unsubscribe: (event: 'insert' | 'update' | 'delete', callback: (data: AugmentedEntity<S>) => void) => void;
  push: (data: EntityData<S>) => AugmentedEntity<S>;
};

type EntityAccessor<S extends z.ZodObject<any>> = {
  insert: (data: EntityData<S>) => AugmentedEntity<S>;
  get: (conditions: number | Partial<InferSchema<S>>) => AugmentedEntity<S> | null;
  findMany: (options: { where?: Record<string, any>; orderBy?: Record<string, 'asc' | 'desc'>; take?: number }) => AugmentedEntity<S>[];
  findUnique: (options: { where: Record<string, any> }) => AugmentedEntity<S> | null;
  findOne: (conditions: Record<string, any>) => AugmentedEntity<S> | null;
  find: (conditions?: Record<string, any>) => AugmentedEntity<S>[];
  update: ((id: number, data: Partial<EntityData<S>>) => AugmentedEntity<S> | null) & ((filter: Partial<InferSchema<S>>, data: Partial<EntityData<S>>) => AugmentedEntity<S> | null);
  upsert: (conditions?: Partial<InferSchema<S>>, data?: Partial<InferSchema<S>>) => AugmentedEntity<S>;
  delete: (id: number) => void;
  subscribe: (event: 'insert' | 'update' | 'delete', callback: (data: AugmentedEntity<S>) => void) => void;
  unsubscribe: (event: 'insert' | 'update' | 'delete', callback: (data: AugmentedEntity<S>) => void) => void;
};

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

    Object.keys(schemas).forEach(entityName => {
      const key = entityName as keyof Schemas;
      const accessor: EntityAccessor<Schemas[typeof key]> = {
        insert: (data) => this.insert(entityName, data),
        get: (conditions) => this.get(entityName, conditions),
        findMany: (options) => this.findMany(entityName, options),
        findUnique: (options) => this.findUnique(entityName, options),
        findOne: (conditions) => this.findOne(entityName, conditions),
        find: (conditions) => this.find(entityName, conditions),
        update: (idOrFilter, data) => this.updateWithFilter(entityName, idOrFilter, data),
        upsert: (conditions, data) => this.upsert(entityName, data, conditions),
        delete: (id) => this.delete(entityName, id),
        subscribe: (event, callback) => this.subscribe(event, entityName, callback),
        unsubscribe: (event, callback) => this.unsubscribe(event, entityName, callback),
      };
      (this as any)[key] = accessor;
    });
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
              const foreignKey = relType === 'belongs-to' ? `${fieldName}Id` : '';
              relationships.push({
                type: relType,
                from: entityName,
                to: targetEntityName,
                relationshipField: fieldName,
                foreignKey,
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
        const belongsToRel = this.relationships.find(r =>
          r.type === 'belongs-to' &&
          r.from === rel.to &&
          r.to === rel.from
        );
        if (!belongsToRel) throw new Error(`No 'belongs-to' relationship found for one-to-many from ${rel.from} to ${rel.to}`);
        const foreignKeyInChild = belongsToRel.foreignKey;
        lazyMethods[rel.from].push({
          name: rel.relationshipField,
          type: 'one-to-many',
          childEntityName: rel.to,
          parentEntityName: rel.from,
          fetch: (entity) => ({
            insert: (data: any) => this.insert(rel.to, { ...data, [foreignKeyInChild]: entity.id }),
            get: (conditions: any) => {
              const queryConditions = typeof conditions === 'number' ? { id: conditions } : conditions;
              return this.get(rel.to, { ...queryConditions, [foreignKeyInChild]: entity.id });
            },
            findOne: (conditions: any) => this.findOne(rel.to, { ...conditions, [foreignKeyInChild]: entity.id }),
            find: (conditions: any = {}) => this.find(rel.to, { ...conditions, [foreignKeyInChild]: entity.id }),
            update: (id: number, data: any) => this.update(rel.to, id, data),
            upsert: (conditions: any = {}, data: any = {}) => this.upsert(rel.to, { ...data, [foreignKeyInChild]: entity.id }, { ...conditions, [foreignKeyInChild]: entity.id }),
            delete: (id?: number) => {
              if (id) {
                this.delete(rel.to, id);
              } else {
                const relatedEntities = this.find(rel.to, { [foreignKeyInChild]: entity.id });
                relatedEntities.forEach(e => this.delete(rel.to, e.id));
              }
            },
            subscribe: (event: any, callback: any) => this.subscribe(event, rel.to, callback),
            unsubscribe: (event: any, callback: any) => this.unsubscribe(event, rel.to, callback),
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
        if (!parentRel) throw new Error(`No one-to-many relationship found for inverse from ${rel.to} to ${rel.from}`);
        const inverseRelationshipField = parentRel.relationshipField;
        const belongsToRel = this.relationships.find(r =>
          r.type === 'belongs-to' &&
          r.from === rel.from &&
          r.to === rel.to
        );
        if (!belongsToRel) throw new Error(`No 'belongs-to' relationship found for ${rel.from} to ${rel.to}`);
        const foreignKeyInChild = belongsToRel.foreignKey;

        if (!lazyMethods[rel.to].some(m => m.name === inverseRelationshipField)) {
          lazyMethods[rel.to].push({
            name: inverseRelationshipField,
            type: 'one-to-many',
            childEntityName: rel.from,
            parentEntityName: rel.to,
            fetch: (entity) => ({
              insert: (data: any) => this.insert(rel.from, { ...data, [foreignKeyInChild]: entity.id }),
              get: (conditions: any) => {
                const queryConditions = typeof conditions === 'number' ? { id: conditions } : conditions;
                return this.get(rel.from, { ...queryConditions, [foreignKeyInChild]: entity.id });
              },
              findOne: (conditions: any) => this.findOne(rel.from, { ...conditions, [foreignKeyInChild]: entity.id }),
              find: (conditions: any = {}) => this.find(rel.from, { ...conditions, [foreignKeyInChild]: entity.id }),
              update: (id: number, data: any) => this.update(rel.from, id, data),
              upsert: (conditions: any = {}, data: any = {}) => this.upsert(rel.from, { ...data, [foreignKeyInChild]: entity.id }, { ...conditions, [foreignKeyInChild]: entity.id }),
              delete: (id?: number) => {
                if (id) {
                  this.delete(rel.from, id);
                } else {
                  const relatedEntities = this.find(rel.from, { [foreignKeyInChild]: entity.id });
                  relatedEntities.forEach(e => this.delete(rel.from, e.id));
                }
              },
              subscribe: (event: any, callback: any) => this.subscribe(event, rel.from, callback),
              unsubscribe: (event: any, callback: any) => this.unsubscribe(event, rel.from, callback),
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
      const storableFieldNames = new Set(storableFields.map(f => f.name));
      let columnDefs = storableFields.map(f => `${f.name} ${this.zodTypeToSqlType(f.type)}`);
      let constraints = [];

      const belongsToRels = this.relationships.filter(
        rel => rel.type === 'belongs-to' && rel.from === entityName
      );
      for (const rel of belongsToRels) {
        if (!storableFieldNames.has(rel.foreignKey)) {
          columnDefs.push(`${rel.foreignKey} INTEGER`);
        }
        constraints.push(`FOREIGN KEY (${rel.foreignKey}) REFERENCES ${rel.to}(id) ON DELETE SET NULL`);
      }

      const createTableSql = `CREATE TABLE IF NOT EXISTS ${entityName} (id INTEGER PRIMARY KEY AUTOINCREMENT, ${columnDefs.join(', ')}${constraints.length > 0 ? ', ' + constraints.join(', ') : ''})`;
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
    if (zodType instanceof z.ZodOptional) {
      zodType = zodType._def.innerType;
    }
    if (zodType instanceof z.ZodDefault) {
      zodType = zodType._def.innerType;
    }

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
      if (includedData && includedData[methodDef.name] !== undefined) {
        if (methodDef.type === 'belongs-to') {
          const includedEntity = includedData[methodDef.name];
          augmentedEntity[methodDef.name] = () => includedEntity;
        } else if (methodDef.type === 'one-to-many') {
          const includedEntities = includedData[methodDef.name] || [];
          const belongsToRel = this.relationships.find(r =>
            r.type === 'belongs-to' &&
            r.from === methodDef.childEntityName! &&
            r.to === methodDef.parentEntityName!
          );
          if (!belongsToRel) throw new Error(`No 'belongs-to' relationship found for one-to-many from ${methodDef.parentEntityName!} to ${methodDef.childEntityName!}`);
          const foreignKeyInChild = belongsToRel.foreignKey;

          augmentedEntity[methodDef.name] = {
            insert: (data: any) => this.insert(methodDef.childEntityName!, { ...data, [foreignKeyInChild]: entity.id }),
            get: (conditions: any) => {
              const queryConditions = typeof conditions === 'number' ? { id: conditions } : conditions;
              return this.get(methodDef.childEntityName!, { ...queryConditions, [foreignKeyInChild]: entity.id });
            },
            findOne: (conditions: any = {}) => {
              return this.findOne(methodDef.childEntityName!, { ...conditions, [foreignKeyInChild]: entity.id });
            },
            find: (conditions: any = {}) => {
              if (Object.keys(conditions).length === 0) {
                return includedEntities;
              }
              return this.find(methodDef.childEntityName!, { ...conditions, [foreignKeyInChild]: entity.id });
            },
            update: (id: number, data: any) => this.update(methodDef.childEntityName!, id, data),
            upsert: (conditions: any = {}, data: any = {}) => this.upsert(methodDef.childEntityName!, { ...data, [foreignKeyInChild]: entity.id }, { ...conditions, [foreignKeyInChild]: entity.id }),
            delete: (id?: number) => {
              if (id) {
                this.delete(methodDef.childEntityName!, id);
              } else {
                const relatedEntities = this.find(methodDef.childEntityName!, { [foreignKeyInChild]: entity.id });
                relatedEntities.forEach(e => this.delete(methodDef.childEntityName!, e.id));
              }
            },
            subscribe: (event: any, callback: any) => this.subscribe(event, methodDef.childEntityName!, callback),
            unsubscribe: (event: any, callback: any) => this.unsubscribe(event, methodDef.childEntityName!, callback),
            push: (data: any) => this.insert(methodDef.childEntityName!, { ...data, [foreignKeyInChild]: entity.id }),
          };
        }
      } else {
        const fetcher = methodDef.fetch(entity);
        if (methodDef.type === 'one-to-many') {
          augmentedEntity[methodDef.name] = fetcher;
        } else {
          augmentedEntity[methodDef.name] = fetcher;
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

  private buildWhereClause(conditions: Record<string, any>, tablePrefix?: string): { clause: string; values: any[] } {
    const whereParts: string[] = [];
    const values: any[] = [];

    for (const key in conditions) {
      if (key.startsWith('$')) continue;

      const value = conditions[key];
      const fieldName = tablePrefix ? `${tablePrefix}.${key}` : key;

      if (typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)) {
        const operator = Object.keys(value)[0];
        if (!operator || !operator.startsWith('$')) {
          throw new Error(`Querying on nested object field '${key}' is not supported. Use simple values or query operators like $gt.`);
        }

        const operand = value[operator];
        let sqlOperator = '';
        switch (operator) {
          case '$gt': sqlOperator = '>'; break;
          case '$gte': sqlOperator = '>='; break;
          case '$lt': sqlOperator = '<'; break;
          case '$lte': sqlOperator = '<='; break;
          case '$ne': sqlOperator = '!='; break;
          case '$in':
            if (!Array.isArray(operand)) throw new Error(`$in operator for field '${key}' requires an array value.`);
            if (operand.length === 0) {
              whereParts.push('1 = 0');
            } else {
              const placeholders = operand.map(() => '?').join(', ');
              whereParts.push(`${fieldName} IN (${placeholders})`);
              values.push(...operand.map(v => this.transformForStorage({ v }).v));
            }
            continue;
          default:
            throw new Error(`Unsupported query operator: '${operator}' on field '${key}'.`);
        }
        whereParts.push(`${fieldName} ${sqlOperator} ?`);
        values.push(this.transformForStorage({ operand }).operand);
      } else {
        whereParts.push(`${fieldName} = ?`);
        values.push(this.transformForStorage({ value }).value);
      }
    }

    return {
      clause: whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '',
      values
    };
  }

  private buildJoinQuery(entityName: string, conditions: Record<string, any>, includeFields: string[]): {
    sql: string;
    values: any[];
    joinedTables: { alias: string; entityName: string; relationship: Relationship }[];
  } {
    const { $limit, $offset, $sortBy, $include, ...whereConditions } = conditions;

    let sql = `SELECT ${entityName}.*`;
    const joinedTables: { alias: string; entityName: string; relationship: Relationship }[] = [];
    const joinClauses: string[] = [];

    for (const includeField of includeFields) {
      const relationship = this.relationships.find(
        rel => rel.from === entityName && rel.relationshipField === includeField && rel.type === 'belongs-to'
      );

      if (relationship) {
        const alias = `${includeField}_tbl`;
        joinedTables.push({ alias, entityName: relationship.to, relationship });

        const joinedSchema = this.schemas[relationship.to];
        const joinedFields = ['id', ...this.getStorableFields(joinedSchema).map(f => f.name)];
        const aliasedColumns = joinedFields.map(field => `${alias}.${field} AS ${alias}_${field}`);
        sql += `, ${aliasedColumns.join(', ')}`;

        joinClauses.push(`LEFT JOIN ${relationship.to} ${alias} ON ${entityName}.${relationship.foreignKey} = ${alias}.id`);
      }
    }

    sql += ` FROM ${entityName}`;
    if (joinClauses.length > 0) {
      sql += ` ${joinClauses.join(' ')}`;
    }

    const { clause: whereClause, values } = this.buildWhereClause(whereConditions, entityName);
    if (whereClause) {
      sql += ` ${whereClause}`;
    }

    if ($sortBy) {
      const [field, direction = 'ASC'] = ($sortBy as string).split(':');
      sql += ` ORDER BY ${entityName}.${field} ${direction.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`;
    }

    if ($limit) sql += ` LIMIT ${$limit}`;
    if ($offset) sql += ` OFFSET ${$offset}`;

    return {
      sql,
      values,
      joinedTables
    };
  }

  private parseJoinResults(rows: any[], entityName: string, joinedTables: { alias: string; entityName: string; relationship: Relationship }[]): {
    entities: any[];
    includedData: Record<string, any>[];
  } {
    const entities: any[] = [];
    const includedDataArray: Record<string, any>[] = [];

    for (const row of rows) {
      const mainEntity: Record<string, any> = {};
      const mainSchema = this.schemas[entityName];
      const mainFields = ['id', ...this.getStorableFields(mainSchema).map(f => f.name)];

      for (const field of mainFields) {
        if (row[field] !== undefined) {
          mainEntity[field] = row[field];
        }
      }

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

  private loadOneToManyIncludes(entityName: string, entities: any[], includeFields: string[]): Record<string, any>[] {
    const includedDataArray: Record<string, any>[] = entities.map(() => ({}));

    for (const includeField of includeFields) {
      const relationship = this.relationships.find(
        rel => rel.from === entityName && rel.relationshipField === includeField && rel.type === 'one-to-many'
      );

      if (relationship) {
        const entityIds = entities.map(e => e.id);
        if (entityIds.length === 0) continue;

        const belongsToRel = this.relationships.find(r =>
          r.type === 'belongs-to' &&
          r.from === relationship.to &&
          r.to === relationship.from
        );
        if (!belongsToRel) throw new Error(`No 'belongs-to' relationship found for one-to-many from ${relationship.from} to ${relationship.to}`);
        const foreignKeyInChild = belongsToRel.foreignKey;

        const placeholders = entityIds.map(() => '?').join(', ');
        const sql = `SELECT * FROM ${relationship.to} WHERE ${foreignKeyInChild} IN (${placeholders})`;
        const relatedRows = this.db.query(sql).all(...entityIds);

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

  private preprocessRelationshipFields(schema: z.ZodObject<any>, data: Record<string, any>): Record<string, any> {
    const processedData = { ...data };
    for (const [key, value] of Object.entries(data)) {
      if (this.isRelationshipField(schema, key)) {
        if (value && typeof value === 'object' && 'id' in value) {
          const foreignKey = `${key}Id`;
          processedData[foreignKey] = value.id;
          delete processedData[key];
        } else if (typeof value === 'string') {
          const foreignKey = `${key}Id`;
          processedData[foreignKey] = value;
          delete processedData[key];
        }
      }
    }
    return processedData;
  }

  private insert<T extends Record<string, any>>(entityName: string, data: Omit<T, 'id'>): AugmentedEntity<any> {
    const schema = this.schemas[entityName];
    const processedData = this.preprocessRelationshipFields(schema, data);
    const validatedData = schema.passthrough().parse(processedData);
    const storableData = Object.fromEntries(
      Object.entries(validatedData).filter(([key]) => !this.isRelationshipField(schema, key))
    );
    const transformedData = this.transformForStorage(storableData);
    const columns = Object.keys(transformedData);
    let sql: string;
    if (columns.length === 0) {
      sql = `INSERT INTO ${entityName} DEFAULT VALUES`;
    } else {
      const placeholders = columns.map(() => '?').join(', ');
      sql = `INSERT INTO ${entityName} (${columns.join(', ')}) VALUES (${placeholders})`;
    }
    const result = this.db.query(sql).run(...Object.values(transformedData));
    const newEntity = this.get(entityName, result.lastInsertRowid as number);
    if (!newEntity) throw new Error('Failed to retrieve entity after insertion');
    this.emit('insert', entityName, newEntity);
    if (this.subscriptions.insert[entityName]) {
      this.subscriptions.insert[entityName].forEach(cb => cb(newEntity));
    }
    return newEntity;
  }

  private get<T extends Record<string, any>>(entityName: string, conditions: number | Partial<T>): AugmentedEntity<any> | null {
    const queryConditions = typeof conditions === 'number' ? { id: conditions } : conditions;
    if (Object.keys(queryConditions).length === 0) return null;
    const results = this.find(entityName, { ...queryConditions, $limit: 1 });
    return results.length > 0 ? results[0] : null;
  }
  private findMany<T extends Record<string, any>>(entityName: string, options: {
    where?: Record<string, any>;
    orderBy?: Record<string, 'asc' | 'desc'>;
    take?: number;
  }): AugmentedEntity<any>[] {
    const { where = {}, orderBy, take } = options;

    // Convert Prisma-style options to internal format
    const conditions: Record<string, any> = { ...where };

    if (orderBy) {
      const field = Object.keys(orderBy)[0];
      const direction = orderBy[field];
      conditions.$sortBy = `${field}:${direction}`;
    }

    if (take) conditions.$limit = take;

    return this.find(entityName, conditions);
  }
  private findUnique<T extends Record<string, any>>(entityName: string, options: {
    where: Record<string, any>;
  }): AugmentedEntity<any> | null {
    const { where } = options;

    // Convert to internal format with limit 1
    const conditions: Record<string, any> = {
      ...where,
      $limit: 1
    };

    const results = this.find(entityName, conditions);
    return results.length > 0 ? results[0] : null;
  }



  private findOne<T extends Record<string, any>>(entityName: string, conditions: Record<string, any>): AugmentedEntity<any> | null {
    const results = this.find(entityName, { ...conditions, $limit: 1 });
    return results.length > 0 ? results[0] : null;
  }

  private find<T extends Record<string, any>>(entityName: string, conditions: Record<string, any> = {}): AugmentedEntity<any>[] {
    const { $include, ...otherConditions } = conditions;

    const includeFields: string[] = [];
    if ($include) {
      if (typeof $include === 'string') {
        includeFields.push($include);
      } else if (Array.isArray($include)) {
        includeFields.push(...$include);
      }
    }

    if (includeFields.length === 0) {
      const { $limit, $offset, $sortBy, ...whereConditions } = otherConditions;
      const { clause: whereClause, values: whereValues } = this.buildWhereClause(whereConditions);
      let orderByClause = '';
      if ($sortBy) {
        const [field, direction = 'ASC'] = ($sortBy as string).split(':');
        orderByClause = `ORDER BY ${field} ${direction.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`;
      }
      const limitClause = $limit ? `LIMIT ${$limit}` : '';
      const offsetClause = $offset ? `OFFSET ${$offset}` : '';
      const sql = `SELECT * FROM ${entityName} ${whereClause} ${orderByClause} ${limitClause} ${offsetClause}`;
      const rows = this.db.query(sql).all(...whereValues);

      return rows.map(row => {
        const entity = this.transformFromStorage(row as any, this.schemas[entityName]) as T;
        return this._attachMethods(entityName, entity);
      });
    }

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
      const { sql, values, joinedTables } = this.buildJoinQuery(entityName, otherConditions, belongsToIncludes);
      console.log(`[Performance] Using JOIN query: ${sql}`);
      const rows = this.db.query(sql).all(...values);
      const result = this.parseJoinResults(rows, entityName, joinedTables);
      entities = result.entities;
      includedDataArray = result.includedData;
    } else {
      const { $limit, $offset, $sortBy, ...whereConditions } = otherConditions;
      const { clause: whereClause, values: whereValues } = this.buildWhereClause(whereConditions);
      let orderByClause = '';
      if ($sortBy) {
        const [field, direction = 'ASC'] = ($sortBy as string).split(':');
        orderByClause = `ORDER BY ${field} ${direction.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`;
      }
      const limitClause = $limit ? `LIMIT ${$limit}` : '';
      const offsetClause = $offset ? `OFFSET ${$offset}` : '';
      const sql = `SELECT * FROM ${entityName} ${whereClause} ${orderByClause} ${limitClause} ${offsetClause}`;
      const rows = this.db.query(sql).all(...whereValues);
      entities = rows.map(row => this.transformFromStorage(row as any, this.schemas[entityName]) as T);
      includedDataArray = entities.map(() => ({}));
    }

    if (oneToManyIncludes.length > 0) {
      console.log(`[Performance] Using batch query for one-to-many: ${oneToManyIncludes.join(', ')}`);
      const oneToManyData = this.loadOneToManyIncludes(entityName, entities, oneToManyIncludes);
      includedDataArray = includedDataArray.map((includedData, index) => ({
        ...includedData,
        ...oneToManyData[index]
      }));
    }

    return entities.map((entity, index) => {
      return this._attachMethods(entityName, entity, includedDataArray[index]);
    });
  }

  private update<T extends Record<string, any>>(entityName: string, id: number, data: Partial<Omit<T, 'id'>>): AugmentedEntity<any> | null {
    const schema = this.schemas[entityName];
    const validatedData = schema!.partial().parse(data);
    const transformedData = this.transformForStorage(validatedData);
    if (Object.keys(transformedData).length === 0) return this.get(entityName, { id } as unknown as Partial<T>);
    const setClause = Object.keys(transformedData).map(key => `${key} = ?`).join(', ');
    const values = [...Object.values(transformedData), id];
    const sql = `UPDATE ${entityName} SET ${setClause} WHERE id = ?`;
    this.db.query(sql).run(...values);
    const updatedEntity = this.get(entityName, { id } as unknown as Partial<T>);
    if (updatedEntity) {
      this.emit('update', entityName, updatedEntity);
      if (this.subscriptions.update[entityName]) {
        this.subscriptions.update[entityName].forEach(cb => cb(updatedEntity));
      }
    }
    return updatedEntity;
  }

  /**
   * Update with either a numeric ID or a filter object.
   * If a number is passed, it's treated as the ID.
   * If an object is passed, it's used as filter conditions to find the row to update.
   */
  private updateWithFilter<T extends Record<string, any>>(
    entityName: string,
    idOrFilter: number | Partial<T>,
    data: Partial<Omit<T, 'id'>>
  ): AugmentedEntity<any> | null {
    // If it's a number, use the existing update method
    if (typeof idOrFilter === 'number') {
      return this.update(entityName, idOrFilter, data);
    }

    // Otherwise, treat it as a filter object - find the entity first
    const entity = this.findOne(entityName, idOrFilter);
    if (!entity) {
      return null;
    }

    // Update using the found entity's ID
    return this.update(entityName, entity.id, data);
  }

  private upsert<T extends Record<string, any>>(entityName: string, data: Omit<T, 'id'> & { id?: string }, conditions: Partial<T> = {}): AugmentedEntity<any> {
    const schema = this.schemas[entityName];
    const processedData = this.preprocessRelationshipFields(schema, data);
    const processedConditions = this.preprocessRelationshipFields(schema, conditions);
    const hasId = processedData.id && typeof processedData.id === 'number';
    const existing = hasId ? this.get(entityName, { id: processedData.id } as Partial<T>) : Object.keys(processedConditions).length > 0 ? this.get(entityName, processedConditions) : null;
    if (existing) {
      const updateData = { ...processedData };
      delete updateData.id;
      return this.update(entityName, existing.id, updateData) as AugmentedEntity<any>;
    } else {
      const insertData = { ...processedConditions, ...processedData };
      delete insertData.id;
      return this.insert(entityName, insertData);
    }
  }

  private delete(entityName: string, id: number): void {
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

  private unsubscribe(event: 'insert' | 'update' | 'delete', entityName: string, callback: (data: any) => void): void {
    if (this.subscriptions[event][entityName]) {
      this.subscriptions[event][entityName] = this.subscriptions[event][entityName].filter(cb => cb !== callback);
    }
  }
}

export type DB<S extends SchemaMap> = SatiDB<S> & TypedAccessors<S>;
export { SatiDB, z };
