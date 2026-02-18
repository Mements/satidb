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
const admin = db.users.select().where({ role: 'admin' }).get();  // single row
const all   = db.users.select().all();                           // all rows
```

---

## Defining Relationships

FK columns go in your schema. The `relations` config declares which FK points to which table:

```typescript
const AuthorSchema = z.object({ name: z.string(), country: z.string() });
const BookSchema   = z.object({ title: z.string(), year: z.number(), author_id: z.number().optional() });

const db = new Database(':memory:', {
  authors: AuthorSchema,
  books:   BookSchema,
}, {
  relations: {
    books: { author_id: 'authors' },
  },
});
```

`books: { author_id: 'authors' }` tells the ORM that `books.author_id` is a foreign key referencing `authors.id`. The ORM automatically:

- Adds `FOREIGN KEY (author_id) REFERENCES authors(id)` constraint
- Infers the inverse one-to-many `authors → books`
- Enables lazy navigation: `book.author()` and `author.books()`
- Enables fluent joins: `db.books.select().join(db.authors).all()`

The nav method name is derived by stripping `_id` from the FK column: `author_id` → `author()`.

---

## Querying — `select()` is the only path

All queries go through `select()`:

```typescript
// Single row
const user = db.users.select().where({ id: 1 }).get();

// All matching rows
const admins = db.users.select().where({ role: 'admin' }).all();

// All rows
const everyone = db.users.select().all();

// Count
const count = db.users.select().count();
```

### Operators

`$gt` `$gte` `$lt` `$lte` `$ne` `$in`

```typescript
const topScorers = db.users.select()
  .where({ score: { $gt: 50 } })
  .orderBy('score', 'desc')
  .limit(10)
  .all();
```

### `$or`

```typescript
const results = db.users.select()
  .where({ $or: [{ role: 'admin' }, { score: { $gt: 50 } }] })
  .all();
```

### Fluent Join

Auto-infers foreign keys from relationships:

```typescript
const rows = db.books.select('title', 'year')
  .join(db.authors, ['name', 'country'])
  .where({ year: { $gt: 1800 } })
  .orderBy('year', 'asc')
  .all();
// → [{ title: 'War and Peace', year: 1869, authors_name: 'Leo Tolstoy', ... }]
```

### `db.query()` — Proxy Query (SQL-like)

Full SQL-like control with destructured table aliases:

```typescript
const rows = db.query(c => {
  const { authors: a, books: b } = c;
  return {
    select: { author: a.name, book: b.title, year: b.year },
    join: [[b.author_id, a.id]],
    where: { [a.country]: 'Russia' },
    orderBy: { [b.year]: 'asc' },
  };
});
```

---

## Lazy Navigation

Relationship fields become callable methods on entities. The method name is the FK column with `_id` stripped:

```typescript
// belongs-to: book.author_id → book.author()
const book = db.books.select().where({ title: 'War and Peace' }).get()!;
const author = book.author();       // → { name: 'Leo Tolstoy', ... }

// one-to-many: author → books
const books = tolstoy.books();      // → [{ title: 'War and Peace' }, ...]

// Chain
const allByAuthor = book.author().books();
```

---

## CRUD

```typescript
// Insert (defaults fill in automatically)
const user = db.users.insert({ name: 'Alice', role: 'admin' });

// Insert with FK
const book = db.books.insert({ title: 'War and Peace', year: 1869, author_id: tolstoy.id });

// Read
const one   = db.users.select().where({ id: 1 }).get();
const some  = db.users.select().where({ role: 'admin' }).all();
const all   = db.users.select().all();
const count = db.users.select().count();

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
const alice = db.users.select().where({ id: 1 }).get()!;
alice.score = 200;    // → UPDATE users SET score = 200 WHERE id = 1
```

---

## Change Listeners — `db.table.on()`

Register listeners for insert, update, and delete events. Uses SQLite triggers + a single global poller — no per-listener overhead.

```typescript
// Listen for new users
const unsub = db.users.on('insert', (user) => {
  console.log('New user:', user.name, user.email);
});

// Listen for updates
db.users.on('update', (user) => {
  console.log('Updated:', user.name);
});

// Listen for deletes (row is gone, only id available)
db.users.on('delete', ({ id }) => {
  console.log('Deleted user id:', id);
});

// Stop listening
unsub();
```

### How it works

```
┌──────────────────────────────────────────────────┐
│  SQLite triggers log every mutation:             │
│                                                  │
│  INSERT → _changes (tbl, op='insert', row_id)    │
│  UPDATE → _changes (tbl, op='update', row_id)    │
│  DELETE → _changes (tbl, op='delete', row_id)    │
│                                                  │
│  Single global poller (default 100ms):           │
│  1. SELECT * FROM _changes WHERE id > @watermark │
│  2. Re-fetch affected rows                       │
│  3. Dispatch to registered on() listeners        │
│  4. Advance watermark, clean up consumed entries  │
└──────────────────────────────────────────────────┘
```

| Feature | Detail |
|---|---|
| **Granularity** | Row-level (knows exactly which row changed) |
| **Operations** | INSERT, UPDATE, DELETE — all detected |
| **Cross-process** | ✅ Triggers fire regardless of which connection writes |
| **Overhead** | Single poller for all listeners, no per-listener timers |
| **Cleanup** | Consumed changes auto-deleted after dispatch |

Run `bun examples/messages-demo.ts` for a full working demo.

---

## Schema Validation

Zod validates every insert and update at runtime:

```typescript
db.users.insert({ name: '', email: 'bad', age: -1 });  // throws ZodError
```

---

## Automatic Migrations

When you add new fields to your Zod schema, the ORM automatically adds the corresponding columns to the SQLite table on startup. No migration files, no manual ALTER TABLE statements.

```typescript
// v1: initial schema
const UserSchema = z.object({
  name: z.string(),
  email: z.string(),
});

// v2: added a new field — just update the Zod schema
const UserSchema = z.object({
  name: z.string(),
  email: z.string(),
  bio: z.string().default(''),      // ← new column added automatically
  score: z.number().default(0),     // ← new column added automatically
});
```

**How it works:**
1. On startup, the ORM reads `PRAGMA table_info(...)` to get existing columns
2. Compares them against the Zod schema fields
3. Any missing columns are added via `ALTER TABLE ... ADD COLUMN`

This handles the common case of additive schema evolution. For destructive changes (renaming or dropping columns), use the SQLite CLI directly.

---

## Indexes

```typescript
const db = new Database(':memory:', schemas, {
  indexes: {
    users: ['email', ['name', 'role']],
    books: ['author_id', 'year'],
  },
});
```

---

## Transactions

```typescript
const result = db.transaction(() => {
  const author = db.authors.insert({ name: 'New Author', country: 'US' });
  const book = db.books.insert({ title: 'New Book', year: 2024, author_id: author.id });
  return { author, book };
});
// Automatically rolls back on error
```

---

## Examples & Tests

```bash
bun examples/messages-demo.ts  # on() change listener demo
bun examples/example.ts        # comprehensive demo
bun test                        # 99 tests
```

---

## API Reference

| Method | Description |
|---|---|
| `new Database(path, schemas, options?)` | Create database with Zod schemas |
| **Querying** | |
| `db.table.select(...cols?).where(filter).get()` | Single row |
| `db.table.select(...cols?).where(filter).all()` | Array of rows |
| `db.table.select().count()` | Count rows |
| `db.table.select().join(db.other, cols?).all()` | Fluent join (auto FK) |
| `db.table.select().with('children').all()` | Eager load related entities (no N+1) |
| `.where({ relation: entity })` | Filter by entity reference |
| `db.query(c => { ... })` | Proxy callback (SQL-like JOINs) |
| **Writing** | |
| `db.table.insert(data)` | Insert with validation |
| `db.table.update(id, data)` | Update by ID |
| `db.table.update(data).where(filter).exec()` | Fluent update |
| `db.table.upsert(match, data)` | Insert or update |
| `db.table.delete(id)` | Delete by ID |
| **Navigation** | |
| `entity.navMethod()` | Lazy navigation (FK name minus `_id`) |
| `entity.update(data)` | Update entity in-place |
| `entity.delete()` | Delete entity |
| **Change Listeners** | |
| `db.table.on('insert', cb)` | Listen for new rows (receives full row) |
| `db.table.on('update', cb)` | Listen for updated rows (receives full row) |
| `db.table.on('delete', cb)` | Listen for deleted rows (receives `{ id }`) |
| **Transactions** | |
| `db.transaction(fn)` | Atomic operation with auto-rollback |

## License

MIT
