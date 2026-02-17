# sqlite-zod-orm

Type-safe SQLite ORM for Bun. Define schemas with Zod, get a fully-typed database with **three ways to query**, automatic relationships, lazy navigation, and zero SQL.

```bash
bun add sqlite-zod-orm
```

## Quick Start

```typescript
import { Database, z } from 'sqlite-zod-orm';

const db = new Database(':memory:', {
  users: z.object({
    name: z.string(),
    email: z.string().email(),
    role: z.string().default('member'),
  }),
});

const alice = db.users.insert({ name: 'Alice', email: 'alice@example.com', role: 'admin' });
const found = db.users.get(1);          // by ID
const admin = db.users.get({ role: 'admin' }); // by filter
```

---

## Three Ways to Query

### 1. Fluent Builder — `select().where().all()`

Single-table queries with chaining. The workhorse API.

```typescript
const trees = db.trees.select()
  .where({ alive: true })
  .orderBy('planted', 'asc')
  .limit(10)
  .all();

// With operators
const old = db.trees.select()
  .where({ planted: { $lt: '1600-01-01' } })
  .all();

// Count / single row
const total = db.trees.select().where({ alive: true }).count();
const oak = db.trees.select().where({ name: 'Major Oak' }).get();
```

**Operators:** `$gt` `$gte` `$lt` `$lte` `$ne` `$in` `$or`

#### `$or` — Disjunctive Filters

```typescript
// Find admins OR users with score > 50
const results = db.users.select()
  .where({ $or: [{ role: 'admin' }, { score: { $gt: 50 } }] })
  .all();

// $or can be combined with regular AND conditions
const alive = db.trees.select()
  .where({ alive: true, $or: [{ name: 'Oak' }, { name: 'Elm' }] })
  .all();
// → WHERE alive = 1 AND (name = 'Oak' OR name = 'Elm')
```

### 2. Fluent Join — `select().join(db.table).all()`

Cross-table queries with auto-inferred foreign keys from `z.lazy()` relationships.

```typescript
const rows = db.trees.select('name', 'planted')
  .join(db.forests, ['name', 'address'])
  .where({ alive: true })
  .orderBy('planted', 'asc')
  .all();
// → [{ name: 'Major Oak', planted: '1500-01-01',
//      forests_name: 'Sherwood', forests_address: 'Nottingham, UK' }]
```

### 3. Proxy Query — `db.query(c => { ... })`

Full SQL-like control with destructured table aliases. Supports WHERE on joined columns.

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
```

---

## Relationships

Define with `z.lazy()`. The ORM auto-creates FK columns and indexes.

```typescript
interface Author { name: string; books?: Book[]; }
interface Book { title: string; author?: Author; }

const AuthorSchema: z.ZodType<Author> = z.object({
  name: z.string(),
  books: z.lazy(() => z.array(BookSchema)).optional(),    // one-to-many
});

const BookSchema: z.ZodType<Book> = z.object({
  title: z.string(),
  author: z.lazy(() => AuthorSchema).optional(),          // belongs-to → auto authorId FK
});
```

### Entity References in Insert & WHERE

Pass entities directly — the ORM resolves to foreign keys automatically:

```typescript
const tolstoy = db.authors.insert({ name: 'Leo Tolstoy' });

// Insert — entity resolves to FK
db.books.insert({ title: 'War and Peace', author: tolstoy });

// WHERE — entity resolves to FK condition
const books = db.books.select().where({ author: tolstoy }).all();
const first = db.books.get({ author: tolstoy });
```

### Lazy Navigation

Every relationship field becomes a callable method on returned entities:

```typescript
// belongs-to: book → author
const book = db.books.get({ title: 'War and Peace' })!;
const author = book.author();       // → { name: 'Leo Tolstoy', ... }

// one-to-many: author → books
const books = tolstoy.books();      // → [{ title: 'War and Peace' }, { title: 'Anna Karenina' }]

// Chain navigation
const book2 = db.books.get(1)!;
const allByAuthor = book2.author().books();
```

---

## CRUD

```typescript
const user = db.users.insert({ name: 'Alice', role: 'admin' });
const found = db.users.get(1);
db.users.update(1, { role: 'superadmin' });
db.users.update({ role: 'member' }).where({ role: 'guest' }).exec();
db.users.upsert({ name: 'Alice' }, { name: 'Alice', role: 'admin' });
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
const db = new Database(':memory:', schemas, { changeTracking: true });
const changes = db.getChangesSince(0);
// [{ table_name: 'users', row_id: 1, action: 'INSERT' }, ...]
```

---

## Event Subscriptions

```typescript
db.users.subscribe('insert', (user) => console.log('New:', user.name));
db.users.subscribe('update', (user) => console.log('Updated:', user.name));
```

---

## Smart Polling

```typescript
const unsub = db.users.select()
  .where({ role: 'admin' })
  .subscribe((admins) => {
    console.log('Admin list changed:', admins);
  }, { interval: 1000 });

unsub(); // stop listening
```

---

## Examples

A single comprehensive example covers all features:

```bash
bun examples/example.ts
```

Integration tests:

```bash
bun test
```

---

## Project Structure

```
src/
  index.ts           — public exports
  database.ts        — Database class
  types.ts           — type definitions
  schema.ts          — schema parsing, storage transforms
  query-builder.ts   — fluent select/join/where/orderBy
  proxy-query.ts     — db.query(c => {...}) proxy callback
  ast.ts             — AST compiler for callback-style WHERE

examples/            — standalone runnable scripts
test/                — unit + integration tests
```

---

## API Reference

| Method | Description |
|---|---|
| `new Database(path, schemas, options?)` | Create database with Zod schemas |
| `db.table.insert(data)` | Insert with validation; entities resolve to FKs |
| `db.table.get(id \| filter)` | Get single row |
| `db.table.update(id, data)` | Update by ID |
| `db.table.update(data).where(filter).exec()` | Fluent update |
| `db.table.upsert(match, data)` | Insert or update |
| `db.table.delete(id)` | Delete by ID |
| `db.table.select().where().orderBy().limit().offset().all()` | Fluent query |
| `db.table.select().where({ $or: [...] })` | OR conditions |
| `db.table.select().join(db.other, cols?).all()` | Fluent join (auto FK) |
| `db.query(c => { ... })` | Proxy callback query |
| `entity.relationship()` | Lazy navigation (read-only) |
| `db.table.select().count()` | Count rows |
| `db.table.select().subscribe(cb, opts)` | Smart polling |
| `db.getChangesSince(version, table?)` | Change tracking |

## License

MIT
