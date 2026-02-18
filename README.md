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

## Schema Validation

Zod validates every insert and update at runtime:

```typescript
db.users.insert({ name: '', email: 'bad', age: -1 });  // throws ZodError
```

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

## Reactivity — `select().subscribe()`

One API to watch any query for changes. Detects **all** mutations (inserts, updates, deletes) with zero disk overhead.

```typescript
const unsub = db.users.select()
  .where({ role: 'admin' })
  .orderBy('name', 'asc')
  .subscribe((admins) => {
    console.log('Admin list:', admins.map(a => a.name));
  }, { interval: 1000 });

// Stop watching
unsub();
```

**Options:**

| Option | Default | Description |
|---|---|---|
| `interval` | `500` | Polling interval in milliseconds |
| `immediate` | `true` | Fire callback immediately with current data |

### How it works

```
┌──────────────────────────────────────────────────┐
│  Every {interval}ms:                             │
│                                                  │
│  1. Check revision (in-memory + data_version)    │
│  2. Run: SELECT COUNT(*), MAX(id)                │
│     FROM users WHERE role = 'admin'              │
│                                                  │
│  3. Combine into fingerprint: "count:max:rev:dv" │
│                                                  │
│  4. If fingerprint changed → re-run full query   │
│     and call your callback                       │
└──────────────────────────────────────────────────┘
```

Two signals combine to detect **all** changes from **any** source:

| Signal | Catches | How |
|---|---|---|
| **In-memory revision** | Same-process writes | Bumped by CRUD methods |
| **PRAGMA data_version** | Cross-process writes | SQLite bumps it on external commits |

| Operation | Detected | Source |
|---|---|---|
| INSERT | ✅ | Same or other process |
| DELETE | ✅ | Same or other process |
| UPDATE | ✅ | Same or other process |

No triggers. No `_changes` table. Zero disk overhead. WAL mode is enabled by default for concurrent read/write.

### Multi-process example

```typescript
// Process A — watches for new/edited messages
const unsub = db.messages.select()
  .orderBy('id', 'asc')
  .subscribe((messages) => {
    console.log('Messages:', messages);
  }, { interval: 200 });

// Process B — writes to the same DB file (different process)
// sqlite3 chat.db "INSERT INTO messages (text, author) VALUES ('hello', 'Bob')"
// → Process A's callback fires with updated message list!
```

Run `bun examples/messages-demo.ts` for a full working demo.

**Use cases:**
- Live dashboards (poll every 1-5s)
- Real-time chat / message lists
- Auto-refreshing data tables
- Watching filtered subsets of data
- Cross-process data synchronization

---

## Examples & Tests

```bash
bun examples/example.ts    # comprehensive demo
bun test                    # 91 tests
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
| **Reactivity** | |
| `select().subscribe(cb, opts?)` | Watch any query for changes (all mutations) |

## License

MIT
