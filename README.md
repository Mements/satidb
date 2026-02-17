# sqlite-zod-orm

Type-safe SQLite ORM for Bun. Define Zod schemas, get a fully-typed database with fluent queries, change tracking, and zero SQL.

## Install

```bash
bun add sqlite-zod-orm
```

## 30-Second Example

```typescript
import { SatiDB, z } from 'sqlite-zod-orm';

const db = new SatiDB(':memory:', {
  users: z.object({
    name: z.string(),
    email: z.string(),
    role: z.enum(['admin', 'user']),
  }),
});

// Insert
const alice = db.users.insert({ name: 'Alice', email: 'alice@co.dev', role: 'admin' });

// Query
const admins = db.users.select().where({ role: 'admin' }).all();
const first  = db.users.select().where({ email: 'alice@co.dev' }).get();
const count  = db.users.select().where({ role: 'user' }).count();

// Update
db.users.update(alice.id, { name: 'Alice Smith' });               // by ID
db.users.update({ role: 'user' }).where({ name: 'Alice' }).exec(); // fluent

// Upsert
db.users.upsert({ email: 'alice@co.dev' }, { name: 'Alice S.', email: 'alice@co.dev', role: 'admin' });

// Delete
db.users.delete(alice.id);
```

## Features

| Feature | Description |
|---------|-------------|
| **Zod schemas** | Define tables with `z.object()` — runtime validation on every insert/update |
| **Fluent `select()`** | `.where()` `.orderBy()` `.limit()` `.offset()` `.count()` `.get()` `.all()` |
| **Fluent `update()`** | `update(data).where(filter).exec()` — single SQL query, no round-trips |
| **Upsert** | Insert-or-update with `upsert(match, data)` |
| **Indexes** | Single and composite indexes, declared in config |
| **Change tracking** | SQLite triggers log every INSERT/UPDATE/DELETE with timestamps |
| **Events** | `subscribe('insert' \| 'update' \| 'delete', callback)` per entity |
| **Zero config** | Works with Bun's built-in SQLite. No migrations, no CLI |

## Query API

Everything goes through `select()` — one fluent builder for all reads:

```typescript
// All rows
db.users.select().all()

// Filtered
db.users.select().where({ role: 'admin' }).all()

// Operators
db.users.select().where({ age: { $gt: 18 } }).all()
db.users.select().where({ status: { $in: ['active', 'trial'] } }).all()

// Sorting + pagination
db.users.select()
  .where({ role: 'user' })
  .orderBy('name', 'asc')
  .limit(10)
  .offset(20)
  .all()

// Single row
db.users.select().where({ email: 'alice@co.dev' }).get()

// Count
db.users.select().where({ role: 'admin' }).count()
```

### Where Operators

| Operator | SQL | Example |
|----------|-----|---------|
| `{ $gt: n }` | `>` | `{ age: { $gt: 18 } }` |
| `{ $gte: n }` | `>=` | `{ score: { $gte: 90 } }` |
| `{ $lt: n }` | `<` | `{ price: { $lt: 100 } }` |
| `{ $lte: n }` | `<=` | `{ rating: { $lte: 3 } }` |
| `{ $ne: v }` | `!=` | `{ status: { $ne: 'deleted' } }` |
| `{ $in: [] }` | `IN` | `{ role: { $in: ['admin', 'mod'] } }` |

## Update API

Two patterns:

```typescript
// By ID — returns the updated entity
const updated = db.users.update(id, { name: 'New Name' });

// Fluent — single SQL query, returns affected row count
const affected = db.users.update({ role: 'user' })
  .where({ lastLogin: { $lt: cutoff } })
  .exec();
```

## Indexes

Declare in options — single column or composite:

```typescript
const db = new SatiDB('app.db', schemas, {
  indexes: {
    users: ['email', 'role'],                  // two single-column indexes
    orders: ['userId', ['userId', 'status']],  // single + composite
  },
});
```

## Change Tracking

Enable trigger-based tracking for polling/sync patterns:

```typescript
const db = new SatiDB('app.db', schemas, {
  changeTracking: true,
});

// Get all changes since sequence number 0
const changes = db.getChangesSince(0);
// [{ id: 1, table_name: 'users', row_id: 1, action: 'INSERT', timestamp: '...' }, ...]

// Filter by table
const userChanges = db.getChangesSince(lastSeq, 'users');
```

## Relationships

Define with `z.lazy()` refs — SatiDB auto-detects belongs-to and one-to-many from your schemas:

```typescript
import { SatiDB, z } from 'sqlite-zod-orm';

const AuthorSchema = z.object({
  name: z.string(),
  posts: z.lazy(() => z.array(PostSchema)).optional(),   // one-to-many
});

const PostSchema = z.object({
  title: z.string(),
  content: z.string(),
  author: z.lazy(() => AuthorSchema).optional(),          // belongs-to
});

const db = new SatiDB(':memory:', {
  authors: AuthorSchema,
  posts: PostSchema,
});

// Insert an author
const author = db.authors.insert({ name: 'Alice' });

// Add a post via the relationship (auto-sets authorId foreign key)
const post = author.posts.push({ title: 'Hello World', content: '...' });

// Navigate back: belongs-to returns a callable
const postAuthor = post.author();   // => { id: 1, name: 'Alice', ... }

// Query children through the relationship
const allPosts = author.posts.find();
const firstPost = author.posts.get(1);
```

**How it works:**
- `z.lazy(() => z.array(Schema))` → **one-to-many** — adds `.push()`, `.find()`, `.get()` methods
- `z.lazy(() => Schema)` → **belongs-to** — adds a callable that returns the parent entity
- Foreign keys are auto-inferred: a `author` belongs-to field creates an `authorId` column

## Events

Subscribe to mutations per entity:

```typescript
db.users.subscribe('insert', (user) => {
  console.log(`New user: ${user.name}`);
});

db.users.subscribe('update', (user) => {
  sendWebhook('user.updated', user);
});

db.users.subscribe('delete', (user) => {
  cleanup(user.id);
});

db.users.unsubscribe('insert', handler);
```

## Real-World Examples

### Process Manager

```typescript
import { SatiDB, z } from 'sqlite-zod-orm';

const db = new SatiDB(':memory:', {
  processes: z.object({
    pid: z.number(),
    name: z.string(),
    command: z.string(),
    workdir: z.string(),
  }),
}, {
  indexes: { processes: ['name', 'pid'] },
  changeTracking: true,
});

// Get latest process by name
const latest = db.processes.select()
  .where({ name: 'web-server' })
  .orderBy('id', 'desc')
  .limit(1)
  .get();

// Remove all by name
const procs = db.processes.select().where({ name: 'worker' }).all();
for (const p of procs) db.processes.delete(p.id);
```

### Platform Database (9 tables)

```typescript
import { SatiDB, z } from 'sqlite-zod-orm';

const db = new SatiDB('galaxy.db', {
  users: UserSchema,
  servers: ServerSchema,
  members: MemberSchema,
  agentTemplates: AgentTemplateSchema,
  agentInstances: AgentInstanceSchema,
  jobs: JobSchema,
  generations: GenerationSchema,
  customAgents: CustomAgentSchema,
  messages: MessageSchema,
}, {
  changeTracking: true,
  indexes: {
    users: ['userId'],
    servers: ['serverId', 'slug'],
    members: ['serverId', ['serverId', 'userId']],
    jobs: ['jobId', 'status'],
    generations: ['jobId', 'instanceId'],
    messages: [['agentInstanceId', 'userId']],
  },
});

// Update balance — single SQL query
db.servers.update({ balance: 750 }).where({ serverId: 'default' }).exec();

// Count generations for a job
const count = db.generations.select().where({ jobId }).count();
db.jobs.update({ generationCount: count }).where({ jobId }).exec();

// Enrich with related data (sync, no await needed)
const job = db.jobs.select().where({ jobId: 'job-001' }).get();
const user = db.users.select().where({ userId: job.userId }).get();
const instance = db.agentInstances.select().where({ instanceId: job.instanceId }).get();
```

See [`examples/`](./examples/) for full implementations with tests:

| Example | What it shows |
|---------|---------------|
| [positions.ts](./examples/positions.ts) | File position tracking with upsert |
| [process-manager.ts](./examples/process-manager.ts) | Process management with retry logic |
| [system-db.ts](./examples/system-db.ts) | Multi-entity system DB with key-value config |
| [galaxy-db.ts](./examples/galaxy-db.ts) | 9-entity AI platform with enrichment and seeding |
| [messaging.test.ts](./examples/messaging.test.ts) | Comprehensive feature showcase (subscriptions, change tracking, upsert) |

## API Reference

### Constructor

```typescript
const db = new SatiDB(path: string, schemas: SchemaMap, options?: {
  changeTracking?: boolean;   // enable INSERT/UPDATE/DELETE logging
  indexes?: Record<string, (string | string[])[]>;  // per-table indexes
});
```

### Entity Methods

| Method | Signature | Returns |
|--------|-----------|---------|
| `insert` | `insert(data)` | `AugmentedEntity` |
| `get` | `get(id)` or `get(filter)` | `AugmentedEntity \| null` |
| `select` | `select()` | `QueryBuilder` |
| `update` | `update(id, data)` | `AugmentedEntity \| null` |
| `update` | `update(data)` | `UpdateBuilder` (chain `.where().exec()`) |
| `upsert` | `upsert(match, data)` | `AugmentedEntity` |
| `delete` | `delete(id)` | `void` |
| `subscribe` | `subscribe(event, callback)` | `void` |
| `unsubscribe` | `unsubscribe(event, callback)` | `void` |

### DB Methods

| Method | Signature | Returns |
|--------|-----------|---------|
| `getChangesSince` | `getChangesSince(seq, table?)` | `Change[]` |

## Requirements

- [Bun](https://bun.sh) ≥ 1.0
- TypeScript ≥ 5.0

## License

MIT
