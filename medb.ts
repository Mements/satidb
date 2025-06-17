import { Database } from 'bun:sqlite';
import { EventEmitter } from 'events';
import { z } from 'zod';

type ZodType = z.ZodTypeAny;
type SchemaMap = Record<string, z.ZodObject<any>>;
type Relationship = {
  type: 'belongs-to' | 'many-to-many' | 'one-to-many';
  from: string;
  to: string;
  field: string;
};

type LazyMethod = {
  name: string;
  fetch: (entity: Record<string, any>) => Promise<any>;
};

interface EntityMethods<T> {
  insert: (data: T) => Promise<void>;
  get: (conditions: Partial<T>) => Promise<(T & Record<string, () => Promise<any>>) | null>;
  find: (conditions?: Partial<T>) => Promise<(T & Record<string, () => Promise<any>>)[]>;
  update: (id: string, data: Partial<T>) => Promise<void>;
  delete: (id: string) => Promise<void>;
  subscribe: (event: 'insert' | 'update' | 'delete', callback: (data: any) => void) => void;
}

type PersonalityData = z.infer<typeof PersonalitySchema>;
type ChatData = z.infer<typeof ChatSchema>;
type MessageData = z.infer<typeof MessageSchema>;
type WalletData = z.infer<typeof WalletSchema>;
type WalletSessionData = z.infer<typeof WalletSessionSchema>;

interface DatabaseInterface {
  personalities: EntityMethods<PersonalityData>;
  chats: EntityMethods<ChatData>;
  messages: EntityMethods<MessageData>;
  wallets: EntityMethods<WalletData>;
  wallet_sessions: EntityMethods<WalletSessionData>;
}

export const PersonalitySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  shortDescription: z.string(),
  imageBlob: z.instanceof(Buffer).optional(),
  category: z.string(),
  isPublic: z.boolean().default(true),
  creator: z.string().default('User'),
  prompt: z.string().optional(),
  created_at: z.date().default(() => new Date()),
  chats: z.lazy(() => ChatSchema).array().optional().describe('relationship:one-to-many'),
  wallets: z.lazy(() => WalletSchema).array().optional().describe('relationship:one-to-many'),
});

export const ChatSchema = z.object({
  id: z.string(),
  title: z.string(),
  lastMessage: z.string().optional(),
  timestamp: z.date().default(() => new Date()),
  personalityId: z.string(),
  personality: z.lazy(() => PersonalitySchema).optional().describe('relationship:belongs-to'),
  messages: z.lazy(() => MessageSchema).array().optional().describe('relationship:one-to-many'),
});

export const MessageSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  content: z.string(),
  isUser: z.boolean(),
  timestamp: z.date().default(() => new Date()),
  chat: z.lazy(() => ChatSchema).optional().describe('relationship:belongs-to'),
});

export const WalletSchema = z.object({
  personalityId: z.string(),
  publicKey: z.string(),
  privateKey: z.string(),
  personality: z.lazy(() => PersonalitySchema).optional().describe('relationship:belongs-to'),
});

export const WalletSessionSchema = z.object({
  wallet_address: z.string(),
  session_token: z.string(),
  created_at: z.date().default(() => new Date()),
});

class MyDatabase extends EventEmitter implements DatabaseInterface {
  private db: Database;
  private schemas: SchemaMap;
  private relationships: Relationship[];
  private lazyMethods: Record<string, LazyMethod[]>;
  private subscriptions: {
    insert: Record<string, (data: any) => void>;
    update: Record<string, (data: any) => void>;
    delete: Record<string, (id: string) => void>;
  };

  constructor(dbFile: string, schemas: SchemaMap) {
    super();
    this.db = new Database(dbFile);
    this.schemas = schemas;
    this.relationships = this.parseRelationships(schemas);
    this.lazyMethods = this.buildLazyMethods();
    this.subscriptions = { insert: {}, update: {}, delete: {} };
    this.initializeTables();

    for (const entityName of Object.keys(schemas)) {
      (this as any)[entityName] = {
        insert: (data: any) => this.insert(entityName, data),
        get: (conditions: any) => this.get(entityName, conditions),
        find: (conditions: any) => this.find(entityName, conditions),
        update: (id: string, data: any) => this.update(entityName, id, data),
        delete: (id: string) => this.delete(entityName, id),
        subscribe: (event: 'insert' | 'update' | 'delete', callback: (data: any) => void) =>
          this.subscribe(event, entityName, callback),
      };
    }
  }

  private parseRelationships(schemas: SchemaMap): Relationship[] {
    const relationships: Relationship[] = [];
    for (const [entityName, schema] of Object.entries(schemas)) {
      const shape = schema.shape as Record<string, ZodType>;
      for (const [fieldName, fieldSchema] of Object.entries(shape)) {
        const description = fieldSchema._def.description;
        if (description?.startsWith('relationship:')) {
          const relType = description.split(':')[1] as 'belongs-to' | 'many-to-many' | 'one-to-many';
          let targetSchema: z.ZodObject<any>;
          if (fieldSchema instanceof z.ZodLazy) {
            targetSchema = fieldSchema._def.getter();
          } else if (
            fieldSchema instanceof z.ZodArray &&
            fieldSchema._def.type instanceof z.ZodLazy
          ) {
            targetSchema = fieldSchema._def.type._def.getter();
          } else if (
            fieldSchema instanceof z.ZodOptional &&
            fieldSchema._def.innerType instanceof z.ZodLazy
          ) {
            targetSchema = fieldSchema._def.innerType._def.getter();
          } else if (
            fieldSchema instanceof z.ZodOptional &&
            fieldSchema._def.innerType instanceof z.ZodArray &&
            fieldSchema._def.innerType._def.type instanceof z.ZodLazy
          ) {
            targetSchema = fieldSchema._def.innerType._def.type._def.getter();
          } else {
            continue;
          }
          const targetEntityName = Object.keys(schemas).find(
            name => schemas[name] === targetSchema
          )!;
          relationships.push({
            type: relType,
            from: entityName,
            to: targetEntityName,
            field: fieldName,
          });
        }
      }
    }
    return relationships;
  }

  private buildLazyMethods(): Record<string, LazyMethod[]> {
    const lazyMethods: Record<string, LazyMethod[]> = {};
    for (const rel of this.relationships) {
      lazyMethods[rel.from] = lazyMethods[rel.from] || [];
      if (rel.type === 'belongs-to') {
        lazyMethods[rel.from].push({
          name: rel.field,
          fetch: async (entity) => {
            const related = await this.get(rel.to, { id: entity[`${rel.to}Id`] });
            return related || null;
          },
        });
        const inverseName = `${rel.from}s`;
        lazyMethods[rel.to] = lazyMethods[rel.to] || [];
        lazyMethods[rel.to].push({
          name: inverseName,
          fetch: async (entity) => this.find(rel.from, { [`${rel.to}Id`]: entity.id }),
        });
      } else if (rel.type === 'many-to-many') {
        lazyMethods[rel.from].push({
          name: rel.field,
          fetch: async (entity) => {
            const junctionTable = `${rel.from}_to_${rel.to}`;
            const rows = await this.db.query(
              `SELECT ${rel.to}Id FROM ${junctionTable} WHERE ${rel.from}Id = ?`
            ).all(entity.id);
            return Promise.all(
              rows.map(row => this.get(rel.to, { id: row[`${rel.to}Id`] }))
            );
          },
        });
        const inverseName = `${rel.from}s`;
        lazyMethods[rel.to] = lazyMethods[rel.to] || [];
        lazyMethods[rel.to].push({
          name: inverseName,
          fetch: async (entity) => {
            const junctionTable = `${rel.from}_to_${rel.to}`;
            const rows = await this.db.query(
              `SELECT ${rel.from}Id FROM ${junctionTable} WHERE ${rel.to}Id = ?`
            ).all(entity.id);
            return Promise.all(
              rows.map(row => this.get(rel.from, { id: row[`${rel.from}Id`] }))
            );
          },
        });
      } else if (rel.type === 'one-to-many') {
        lazyMethods[rel.from].push({
          name: rel.field,
          fetch: async (entity) => this.find(rel.to, { [`${rel.from}Id`]: entity.id }),
        });
      }
    }
    return lazyMethods;
  }

  private initializeTables(): void {
    for (const [entityName, schema] of Object.entries(this.schemas)) {
      const storableFields = this.getStorableFields(schema);
      const columns = storableFields.map(
        f => `${f.name} ${this.zodTypeToSqlType(f.type)}`
      );
      const foreignKeys: string[] = [];

      const belongsToRels = this.relationships.filter(
        rel => rel.type === 'belongs-to' && rel.from === entityName
      );
      for (const rel of belongsToRels) {
        columns.push(`${rel.to}Id TEXT`);
        foreignKeys.push(`FOREIGN KEY (${rel.to}Id) REFERENCES ${rel.to}(id)`);
      }

      const createTableSql = `CREATE TABLE IF NOT EXISTS ${entityName} (
        id TEXT PRIMARY KEY,
        ${columns.join(', ')}${foreignKeys.length ? ', ' + foreignKeys.join(', ') : ''}
      )`;
      this.db.run(createTableSql);
    }

    const manyToManyRels = this.relationships.filter(
      rel => rel.type === 'many-to-many'
    );
    for (const rel of manyToManyRels) {
      const junctionTable = `${rel.from}_to_${rel.to}`;
      const sql = `CREATE TABLE IF NOT EXISTS ${junctionTable} (
        ${rel.from}Id TEXT,
        ${rel.to}Id TEXT,
        PRIMARY KEY (${rel.from}Id, ${rel.to}Id),
        FOREIGN KEY (${rel.from}Id) REFERENCES ${rel.from}(id),
        FOREIGN KEY (${rel.to}Id) REFERENCES ${rel.to}(id)
      )`;
      this.db.run(sql);
    }
  }

  private getStorableFields(schema: z.ZodObject<any>): { name: string; type: ZodType }[] {
    return Object.entries(schema.shape)
      .filter(([name, fieldSchema]) => {
        const desc = (fieldSchema as z.ZodTypeAny)._def.description;
        return name !== 'id' && !(desc && desc.startsWith('relationship:'));
      })
      .map(([name, type]) => ({ name, type: type as ZodType }));
  }

  private zodTypeToSqlType(zodType: ZodType): string {
    if (zodType instanceof z.ZodString) return 'TEXT';
    if (zodType instanceof z.ZodNumber) return 'INTEGER';
    if (zodType instanceof z.ZodBoolean) return 'INTEGER';
    if (zodType instanceof z.ZodDate) return 'TEXT';
    if (zodType._def.typeName === 'ZodInstanceOf' && zodType._def.type === Buffer)
      return 'BLOB';
    return 'TEXT';
  }

  private transformForStorage(data: Record<string, any>): Record<string, any> {
    const transformed: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value instanceof Date) {
        transformed[key] = value.toISOString();
      } else if (Buffer.isBuffer(value)) {
        transformed[key] = value;
      } else {
        transformed[key] = value;
      }
    }
    return transformed;
  }

  private transformFromStorage(
    row: Record<string, any>,
    schema: z.ZodObject<any>
  ): Record<string, any> {
    const transformed: Record<string, any> = {};
    for (const [key, value] of Object.entries(row)) {
      let fieldSchema = schema.shape[key];
      if (fieldSchema instanceof z.ZodDefault) {
        fieldSchema = fieldSchema._def.innerType;
      }
      if (fieldSchema instanceof z.ZodDate && typeof value === 'string') {
        transformed[key] = new Date(value);
      } else if (
        fieldSchema?._def.typeName === 'ZodInstanceOf' &&
        fieldSchema._def.type === Buffer &&
        value instanceof Uint8Array
      ) {
        transformed[key] = Buffer.from(value);
      } else if (fieldSchema instanceof z.ZodBoolean && typeof value === 'string') {
        transformed[key] = value === '1' ? true : false;
      } else {
        transformed[key] = value;
      }
    }
    return transformed;
  }

  async insert<T extends Record<string, any>>(
    entityName: string,
    data: T
  ): Promise<void> {
    const schema = this.schemas[entityName];
    const validatedData = schema.parse(data);
    const storableData = Object.fromEntries(
      Object.entries(validatedData).filter(([key]) => !this.isRelationshipField(schema, key))
    );
    const transformedData = this.transformForStorage(storableData);
    const columns = Object.keys(transformedData).join(', ');
    const placeholders = Object.keys(transformedData).map(() => '?').join(', ');
    const values = Object.values(transformedData);
    const sql = `INSERT INTO ${entityName} (${columns}) VALUES (${placeholders})`;
    await this.db.query(sql).run(...values);

    const manyToManyRels = this.relationships.filter(
      rel => rel.type === 'many-to-many' && rel.from === entityName
    );
    for (const rel of manyToManyRels) {
      if (data[rel.field]) {
        const junctionTable = `${rel.from}_to_${rel.to}`;
        for (const relatedId of data[rel.field] as string[]) {
          const junctionSql = `INSERT INTO ${junctionTable} (${rel.from}Id, ${rel.to}Id) VALUES (?, ?)`;
          await this.db.query(junctionSql).run(validatedData.id, relatedId);
        }
      }
    }

    this.emit('insert', entityName, validatedData);
    if (this.subscriptions.insert[entityName]) {
      this.subscriptions.insert[entityName](validatedData);
    }
  }

  private isRelationshipField(schema: z.ZodObject<any>, key: string): boolean {
    const fieldSchema = schema.shape[key];
    return fieldSchema?._def.description?.startsWith('relationship:') ?? false;
  }

  async get<T extends Record<string, any>>(
    entityName: string,
    conditions: Partial<T>
  ): Promise<(T & Record<string, () => Promise<any>>) | null> {
    const whereClause = Object.keys(conditions)
      .map(key => `${key} = ?`)
      .join(' AND ');
    const sql = `SELECT * FROM ${entityName} WHERE ${whereClause}`;
    const row = await this.db.query(sql).get(...Object.values(conditions));
    if (row) {
      const entity = this.transformFromStorage(row, this.schemas[entityName]) as T;
      const methods = this.lazyMethods[entityName] || [];
      for (const { name, fetch } of methods) {
        (entity as any)[name] = fetch.bind(this, entity);
      }
      return entity as T & Record<string, () => Promise<any>>;
    }
    return null;
  }

  async find<T extends Record<string, any>>(
    entityName: string,
    conditions: Partial<T> = {}
  ): Promise<(T & Record<string, () => Promise<any>>)[]> {
    const whereClause = Object.keys(conditions).length
      ? `WHERE ${Object.keys(conditions).map(key => `${key} = ?`).join(' AND ')}`
      : '';
    const sql = `SELECT * FROM ${entityName} ${whereClause}`;
    const rows = await this.db.query(sql).all(...Object.values(conditions));
    return rows.map(row => {
      const entity = this.transformFromStorage(row, this.schemas[entityName]) as T;
      const methods = this.lazyMethods[entityName] || [];
      for (const { name, fetch } of methods) {
        (entity as any)[name] = fetch.bind(this, entity);
      }
      return entity as T & Record<string, () => Promise<any>>;
    });
  }

  async update<T extends Record<string, any>>(
    entityName: string,
    id: string,
    data: Partial<T>
  ): Promise<void> {
    const schema = this.schemas[entityName];
    const partialSchema = schema.partial();
    const validatedData = partialSchema.parse(data);
    const transformedData = this.transformForStorage(validatedData);
    const setClause = Object.keys(transformedData)
      .map(key => `${key} = ?`)
      .join(', ');
    const values = [...Object.values(transformedData), id];
    const sql = `UPDATE ${entityName} SET ${setClause} WHERE id = ?`;
    await this.db.query(sql).run(...values);

    const updatedEntity = await this.get(entityName, { id });
    this.emit('update', entityName, updatedEntity);
    if (this.subscriptions.update[entityName]) {
      this.subscriptions.update[entityName](updatedEntity);
    }
  }

  async delete(entityName: string, id: string): Promise<void> {
    const entity = await this.get(entityName, { id });
    const sql = `DELETE FROM ${entityName} WHERE id = ?`;
    await this.db.query(sql).run(id);
    this.emit('delete', entityName, entity || { id });
    if (this.subscriptions.delete[entityName]) {
      this.subscriptions.delete[entityName](entity || { id });
    }
  }

  subscribe(
    event: 'insert' | 'update' | 'delete',
    entityName: string,
    callback: (data: any) => void
  ): void {
    this.subscriptions[event][entityName] = callback;
  }
}

export { MyDatabase, z };