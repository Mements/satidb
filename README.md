# sqlite-zod-orm

Type-safe SQLite ORM for Bun. Define schemas with Zod, get a fully-typed database with automatic relationships, lazy navigation, and zero SQL.

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
```

---

## Reading Data — Four Ways

Every table accessor gives you four ways to query, from simple to powerful:

### `.get(id | filter)` — Single Row

Quick lookup. Returns one entity or `null`.

```typescript
const user = db.users.get(1);                     // by ID
const admin = db.users.get({ role: 'admin' });     // by filter
```

### `.find(filter?)` — Array of Matching Rows

Returns all rows matching conditions. Omit the filter to get everything.

```typescript
const members = db.users.find({ role: 'member' });
const everyone = db.users.find();                  // all rows
// shorthand:
const all = db.users.all();                        // same as find()
```

### `.select()` — Fluent Query Builder

Chain `.where()`, `.orderBy()`, `.limit()`, `.offset()`, `.join()` for complex queries:

```typescript
const topScorers = db.users.select()
  .where({ score: { $gt: 50 } })
  .orderBy('score', 'desc')
  .limit(10)
  .all();

// Pick specific columns
const names = db.users.select('name', 'email')
  .where({ role: 'admin' })
  .all();

// Single result
const first = db.users.select().orderBy('name').get();

// Count
const total = db.users.select().where({ alive: true }).count();
```

**Operators:** `$gt` `$gte` `$lt` `$lte` `$ne` `$in`

#### `$or` — Disjunctive Filters

```typescript
// Find admins OR high scorers
const results = db.users.select()
  .where({ $or: [{ role: 'admin' }, { score: { $gt: 50 } }] })
  .all();

// $or combined with AND conditions
const alive = db.trees.select()
  .where({ alive: true, $or: [{ name: 'Oak' }, { name: 'Elm' }] })
  .all();
// → WHERE alive = 1 AND (name = 'Oak' OR name = 'Elm')
```

#### Fluent Join — Cross-Table Queries

Auto-infers foreign keys from `z.lazy()` relationships:

```typescript
const rows = db.books.select('title', 'year')
  .join(db.authors, ['name', 'country'])
  .where({ year: { $gt: 1800 } })
  .orderBy('year', 'asc')
  .all();
// → [{ title: 'Crime and Punishment', year: 1866,
//      authors_name: 'Dostoevsky', authors_country: 'Russia' }]
```

### `db.query()` — Proxy Query (SQL-like)

Full SQL-like control with destructured table aliases. Supports WHERE/ORDER BY on joined columns.

```typescript
const rows = db.query(c => {
  const { authors: a, books: b } = c;
  return {
    select: { author: a.name, book: b.title, year: b.year },
    join: [[b.author, a.id]],
    where: { [a.country]: 'Russia' },
    orderBy: { [b.year]: 'asc' },
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

### Entity References

Pass entities directly in `insert()` and `where()` — the ORM resolves to foreign keys:

```typescript
const tolstoy = db.authors.insert({ name: 'Leo Tolstoy' });

// Insert — entity resolves to FK automatically
db.books.insert({ title: 'War and Peace', author: tolstoy });

// WHERE — entity resolves to FK condition
const books = db.books.find({ author: tolstoy });
const first = db.books.get({ author: tolstoy });
const fluent = db.books.select().where({ author: tolstoy }).all();
```

### Lazy Navigation

Every relationship field becomes a callable method on returned entities:

```typescript
// belongs-to: book → author
const book = db.books.get({ title: 'War and Peace' })!;
const author = book.author();       // → { name: 'Leo Tolstoy', ... }

// one-to-many: author → books
const books = tolstoy.books();      // → [{ title: 'War and Peace' }, ...]

// Chain navigation
const allByAuthor = book.author().books();
```

---

## CRUD

```typescript
// Insert (defaults fill in automatically)
const user = db.users.insert({ name: 'Alice', role: 'admin' });

// Read
const found = db.users.get(1);
const admins = db.users.find({ role: 'admin' });
const all = db.users.all();

// Entity-level update
user.update({ role: 'superadmin' });

// Update by ID
db.users.update(1, { role: 'superadmin' });

// Fluent update with WHERE
db.users.update({ role: 'member' }).where({ role: 'guest' }).exec();

// Upsert
db.users.upsert({ name: 'Alice' }, { name: 'Alice', role: 'admin' });

// Delete
db.users.delete(1);
```

### Auto-Persist Proxy

Setting a property on an entity auto-updates the DB:

```typescript
const alice = db.users.get(1)!;
alice.score = 200;    // → UPDATE users SET score = 200 WHERE id = 1
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
    books: ['authorId', 'year'],
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
| **Reading** | |
| `db.table.get(id \| filter)` | Single row by ID or filter |
| `db.table.find(filter?)` | Array of matching rows |
| `db.table.all()` | All rows |
| `db.table.select(...cols?)` | Fluent query builder |
| `db.table.select().where(filter).all()` | Fluent query with conditions |
| `db.table.select().where({ $or: [...] })` | OR conditions |
| `db.table.select().join(db.other, cols?).all()` | Fluent join (auto FK) |
| `db.table.select().count()` | Count rows |
| `db.query(c => { ... })` | Proxy callback (SQL-like JOINs) |
| **Writing** | |
| `db.table.insert(data)` | Insert with validation; entities resolve to FKs |
| `db.table.update(id, data)` | Update by ID |
| `db.table.update(data).where(filter).exec()` | Fluent update |
| `db.table.upsert(match, data)` | Insert or update |
| `db.table.delete(id)` | Delete by ID |
| **Navigation** | |
| `entity.relationship()` | Lazy navigation (read-only) |
| `entity.update(data)` | Update entity in-place |
| `entity.delete()` | Delete entity |
| **Events** | |
| `db.table.subscribe(event, callback)` | Listen for insert/update/delete |
| `db.table.select().subscribe(cb, opts)` | Smart polling |
| `db.getChangesSince(version, table?)` | Change tracking |

## License

MIT
