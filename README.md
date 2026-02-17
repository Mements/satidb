# sqlite-zod-orm

Type-safe SQLite ORM for Bun. Define schemas with Zod, get a fully-typed database with **three ways to query**, automatic relationships, and zero SQL.

```bash
bun add sqlite-zod-orm
```

## Quick Start

```typescript
import { Database, z } from 'sqlite-zod-orm';

const db = new Database(':memory:', {
  forests: z.object({
    name: z.string(),
    address: z.string(),
    trees: z.lazy(() => z.array(TreeSchema)).optional(), // one-to-many
  }),
  trees: z.object({
    name: z.string(),
    planted: z.string(),
    alive: z.boolean().default(true),
    forest: z.lazy(() => ForestSchema).optional(),       // belongs-to → auto FK
  }),
});

// Insert
const sherwood = db.forests.insert({ name: 'Sherwood', address: 'Nottingham, UK' });

// Insert via relationship (auto-sets forestId)
sherwood.trees.push({ name: 'Major Oak', planted: '1500-01-01' });
```

---

## Three Ways to Query

### 1. Fluent Builder — `select().where().all()`

Single-table queries with chaining. The workhorse API.

```typescript
// All alive trees, sorted by planting date
const trees = db.trees.select()
  .where({ alive: true })
  .orderBy('planted', 'asc')
  .limit(10)
  .all();

// With operators
const old = db.trees.select()
  .where({ planted: { $lt: '1600-01-01' } })
  .all();

// Count
const total = db.trees.select().where({ alive: true }).count();

// Single row
const oak = db.trees.select().where({ name: 'Major Oak' }).get();
```

**Operators:** `$gt` `$gte` `$lt` `$lte` `$ne` `$in`

### 2. Fluent Join — `select().join(db.table).all()`

Cross-table queries with auto-inferred foreign keys. No SQL, no manual FK strings.

```typescript
// Join trees with their forest — FK auto-detected from z.lazy() relationship
const rows = db.trees.select('name', 'planted')
  .join(db.forests, ['name', 'address'])
  .where({ alive: true })
  .orderBy('planted', 'asc')
  .all();

// Result: [{ name: 'Major Oak', planted: '1500-01-01', forests_name: 'Sherwood', forests_address: 'Nottingham, UK' }]
```

The join is resolved automatically from your `z.lazy()` relationship declarations — no need to specify `forestId` or `id`.

### 3. Proxy Query — `db.query(c => { ... })`

Full SQL-like control with destructured table aliases. For complex multi-table joins.

```typescript
const rows = db.query(c => {
  const { forests: f, trees: t } = c;
  return {
    select: { tree: t.name, forest: f.name, planted: t.planted },
    join: [[t.forestId, f.id]],
    where: { [f.name]: 'Sherwood' },
    orderBy: { [t.planted]: 'asc' },
  };
});
// [{ tree: 'Major Oak', forest: 'Sherwood', planted: '1500-01-01' }, ...]
```

---

## Relationships

Define relationships with `z.lazy()`. The ORM auto-creates foreign key columns (integer), indexes, and navigation methods.

```typescript
interface Author { name: string; posts?: Post[]; }
interface Post { title: string; author?: Author; }

const AuthorSchema: z.ZodType<Author> = z.object({
  name: z.string(),
  posts: z.lazy(() => z.array(PostSchema)).optional(),    // one-to-many
});

const PostSchema: z.ZodType<Post> = z.object({
  title: z.string(),
  author: z.lazy(() => AuthorSchema).optional(),          // belongs-to → auto authorId FK
});
```

**Navigation:**

```typescript
// belongs-to: navigate child → parent
const post = db.posts.select().where({ title: 'Hello' }).get();
const author = post.author();  // → { id: 1, name: 'Alice' }

// one-to-many: navigate parent → children
const alice = db.authors.get({ name: 'Alice' });
const posts = alice.posts.find();  // → [{ id: 1, title: 'Hello' }, ...]

// insert via relationship (auto-sets authorId)
alice.posts.push({ title: 'New Post' });
```

---

## CRUD

```typescript
// Insert
const user = db.users.insert({ name: 'Alice', role: 'admin' });

// Get by ID
const found = db.users.get(1);

// Get by filter
const admin = db.users.get({ role: 'admin' });

// Update by ID
db.users.update(1, { role: 'superadmin' });

// Fluent update (returns affected count)
db.users.update({ role: 'member' }).where({ role: 'guest' }).exec();

// Upsert
db.users.upsert({ name: 'Alice' }, { name: 'Alice', role: 'admin' });

// Delete
db.users.delete(1);
```

---

## Schema Validation

Zod validates every insert and update at runtime:

```typescript
const db = new Database(':memory:', {
  users: z.object({
    name: z.string().min(1),
    email: z.string().email(),
    age: z.number().int().positive(),
  }),
});

db.users.insert({ name: '', email: 'bad', age: -1 });  // throws ZodError
```

Defaults work too:

```typescript
const TreeSchema = z.object({
  name: z.string(),
  alive: z.boolean().default(true),  // auto-applied on insert
});
```

---

## Indexes

```typescript
const db = new Database(':memory:', schemas, {
  indexes: {
    users: ['email', ['name', 'role']],  // single + composite
    trees: ['forestId', 'planted'],
  },
});
```

---

## Change Tracking

```typescript
const db = new Database(':memory:', schemas, {
  changeTracking: true,
});

// Get all changes since version 0
const changes = db.getChangesSince(0);
// [{ version: 1, table_name: 'users', row_id: 1, action: 'INSERT' }, ...]

// Filter by table
const userChanges = db.getChangesSince(0, 'users');
```

---

## Event Subscriptions

```typescript
db.users.subscribe('insert', (user) => {
  console.log('New user:', user.name);
});

db.users.subscribe('update', (user) => {
  console.log('Updated:', user.name);
});

db.users.subscribe('delete', (user) => {
  console.log('Deleted:', user.id);
});
```

---

## Smart Polling (subscribe to query changes)

```typescript
const unsub = db.users.select()
  .where({ role: 'admin' })
  .orderBy('name', 'asc')
  .subscribe((admins) => {
    console.log('Admin list changed:', admins);
  }, { interval: 1000 });

// Stop listening
unsub();
```

Uses fingerprint-based polling (`COUNT + MAX(id)`) — only re-fetches when data actually changes.

---

## AST-Based Queries

For complex expressions, use the callback-style WHERE with full operator support:

```typescript
const results = db.users.select()
  .where((c, f, op) => op.and(
    op.eq(f.lower(c.name), 'alice'),
    op.gt(c.age, 18)
  ))
  .all();
```

---

## Full Example

See [`examples/forests.ts`](./examples/forests.ts) and [`examples/forests.test.ts`](./examples/forests.test.ts) for a complete working example covering all three query styles, relationships, mutations, validation, and more.

```bash
bun test examples/forests.test.ts
```

---

## API Reference

| Method | Description |
|---|---|
| `new Database(path, schemas, options?)` | Create database with Zod schemas |
| `db.table.insert(data)` | Insert with validation |
| `db.table.get(id \| filter)` | Get single row |
| `db.table.update(id, data)` | Update by ID |
| `db.table.update(data).where(filter).exec()` | Fluent update |
| `db.table.upsert(match, data)` | Insert or update |
| `db.table.delete(id)` | Delete by ID |
| `db.table.select().where().orderBy().limit().offset().all()` | Fluent query |
| `db.table.select().join(db.other, cols?).all()` | Fluent join (auto FK) |
| `db.query(c => { ... })` | Proxy callback query |
| `db.table.select().count()` | Count rows |
| `db.table.select().subscribe(cb, opts)` | Smart polling |
| `db.getChangesSince(version, table?)` | Change tracking |
| `entity.parent()` | Navigate belongs-to |
| `entity.children.find()` | Navigate one-to-many |
| `entity.children.push(data)` | Insert via relationship |

## License

MIT
