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

## Defining Relationships

Declare relationships in the constructor options — no `z.lazy()` or interface boilerplate needed:

```typescript
const AuthorSchema = z.object({ name: z.string(), country: z.string() });
const BookSchema = z.object({ title: z.string(), year: z.number() });

const db = new Database(':memory:', {
  authors: AuthorSchema,
  books: BookSchema,
}, {
  relations: {
    books: { author: 'authors' },   // books.author → authors (belongs-to)
  },
});
```

**That's it.** The ORM automatically:
- Creates `authorId` FK column on `books`
- Infers the inverse `authors → books` (one-to-many)
- Enables lazy navigation: `book.author()`, `author.books()`
- Enables entity references in insert/where: `{ author: tolstoy }`
- Enables fluent joins: `db.books.select().join(db.authors).all()`

> **Note:** `z.lazy()` is still supported for backwards compatibility, but the `relations` config is recommended for cleaner schemas.

---

## Reading Data — Four Ways

### `.get(id | filter)` — Single Row

```typescript
const user = db.users.get(1);                     // by ID
const admin = db.users.get({ role: 'admin' });     // by filter
```

### `.find(filter?)` — Array of Matching Rows

```typescript
const members = db.users.find({ role: 'member' });
const everyone = db.users.find();                  // all rows
const all = db.users.all();                        // shorthand
```

### `.select()` — Fluent Query Builder

```typescript
const topScorers = db.users.select()
  .where({ score: { $gt: 50 } })
  .orderBy('score', 'desc')
  .limit(10)
  .all();
```

**Operators:** `$gt` `$gte` `$lt` `$lte` `$ne` `$in`

#### `$or` — Disjunctive Filters

```typescript
const results = db.users.select()
  .where({ $or: [{ role: 'admin' }, { score: { $gt: 50 } }] })
  .all();

// Combined with AND
const alive = db.trees.select()
  .where({ alive: true, $or: [{ name: 'Oak' }, { name: 'Elm' }] })
  .all();
// → WHERE alive = 1 AND (name = 'Oak' OR name = 'Elm')
```

#### Fluent Join

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
    join: [[b.author, a.id]],
    where: { [a.country]: 'Russia' },
    orderBy: { [b.year]: 'asc' },
  };
});
```

---

## Entity References

Pass entities directly in `insert()` and `where()` — the ORM resolves to foreign keys:

```typescript
const tolstoy = db.authors.insert({ name: 'Leo Tolstoy', country: 'Russia' });

// Insert — entity resolves to FK
db.books.insert({ title: 'War and Peace', year: 1869, author: tolstoy });

// WHERE — entity resolves to FK condition
const books = db.books.find({ author: tolstoy });
const first = db.books.get({ author: tolstoy });
```

## Lazy Navigation

Relationship fields become callable methods on returned entities:

```typescript
// belongs-to: book → author
const book = db.books.get({ title: 'War and Peace' })!;
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
db.users.insert({ name: '', email: 'bad', age: -1 });  // throws ZodError
```

---

## Indexes

```typescript
const db = new Database(':memory:', schemas, {
  indexes: {
    users: ['email', ['name', 'role']],
    books: ['authorId', 'year'],
  },
});
```

---

## Change Tracking & Events

```typescript
const db = new Database(':memory:', schemas, { changeTracking: true });
db.getChangesSince(0);

db.users.subscribe('insert', (user) => console.log('New:', user.name));
```

---

## Smart Polling

```typescript
const unsub = db.users.select()
  .where({ role: 'admin' })
  .subscribe((admins) => {
    console.log('Admin list changed:', admins);
  }, { interval: 1000 });

unsub();
```

---

## Examples & Tests

```bash
bun examples/example.ts    # comprehensive demo
bun test                    # 90 tests
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
