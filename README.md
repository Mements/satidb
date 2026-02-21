# sqlite-zod-orm

Type-safe SQLite ORM for Bun — Zod schemas, fluent queries, auto relationships, zero SQL.

```bash
bun add sqlite-zod-orm
```

## Quick Start

```typescript
import { Database, z } from 'sqlite-zod-orm';

const db = new Database('app.db', {
    users: z.object({
        name: z.string(),
        email: z.string(),
        score: z.number().default(0),
    }),
    posts: z.object({
        title: z.string(),
        body: z.string(),
        userId: z.number(),
    }),
}, {
    relations: { posts: { userId: 'users' } },
    timestamps: true,
    softDeletes: true,
});
```

Tables are auto-created and auto-migrated from your Zod schemas. No SQL required.

## CRUD

```typescript
// Insert
const user = db.users.insert({ name: 'Alice', email: 'alice@co.com' });

// Read
const all = db.users.select().all();
const one = db.users.get(1);
const found = db.users.select().where({ name: 'Alice' }).first();

// Update (auto-persists via proxy)
user.score = 100;  // ← saved to DB automatically

// Delete
db.users.delete(1);

// Batch
db.users.insertMany([{ name: 'Bob', email: 'b@co.com' }, { name: 'Charlie', email: 'c@co.com' }]);
db.users.upsertMany([{ id: 1, name: 'Updated Alice' }], 'id');
```

## Fluent Query Builder

```typescript
db.users.select()
    .where({ score: { $gte: 50 } })
    .orderBy('score', 'DESC')
    .limit(10)
    .all();

// Operators: $gt, $gte, $lt, $lte, $ne, $like, $in, $notIn, $between
db.users.select().where({ name: { $like: '%ali%' } }).all();

// whereIn / whereNotIn (array or subquery)
db.users.select().whereIn('id', [1, 2, 3]).all();
const sub = db.orders.select('userId');
db.users.select().whereIn('id', sub).all();

// Raw WHERE fragments
db.users.select().whereRaw('score > ? AND name != ?', [50, 'Bot']).all();
```

## Relationships

```typescript
// Navigation (lazy, proxy-based)
const post = db.posts.get(1);
post.user;           // → related user object
const user = db.users.get(1);
user.posts;          // → array of user's posts

// Eager loading (no N+1)
db.posts.select().with('user').all();
```

## Aggregates

```typescript
db.users.count();                                   // shorthand
db.users.select().where({ role: 'admin' }).count(); // filtered
db.users.select().sum('score');
db.users.select().avg('score');
db.users.select().min('score');
db.users.select().max('score');
```

## Batch Mutations

```typescript
db.users.select().where({ role: 'guest' }).updateAll({ role: 'member' }); // → affected count
db.users.select().where({ role: 'spam' }).deleteAll();                    // → deleted count
```

## Pagination

```typescript
const page = db.users.select().orderBy('name').paginate(1, 20);
// { data: [...], total: 42, page: 1, perPage: 20, pages: 3 }
```

## Select Type Narrowing

```typescript
const names = db.users.select('name', 'email').all();
names[0].name;  // ✅ string
names[0].score; // ❌ TypeScript error — not selected
```

## Computed Getters

```typescript
const db = new Database(':memory:', { users: UserSchema }, {
    computed: {
        users: { fullName: (u) => `${u.first} ${u.last}` },
    },
});
user.fullName; // 'Alice Smith' — recomputes on access
```

## Cascade Deletes

```typescript
const db = new Database(':memory:', { authors: AuthorSchema, books: BookSchema }, {
    relations: { books: { author_id: 'authors' } },
    cascade: { authors: ['books'] },
});
db.authors.delete(1); // → books with author_id=1 also deleted
```

## Transactions

```typescript
db.transaction(() => {
    db.users.insert({ name: 'Alice' });
    db.orders.insert({ userId: 1, amount: 100 });
}); // auto-commits; rolls back on error
```

## Data Import / Export

```typescript
const backup = db.dump();                      // export all tables as JSON
db.load(backup);                               // restore (truncates first)
db.load(backup, { append: true });             // restore without truncating
db.seed({ users: [{ name: 'Test User' }] });   // additive fixture seeding
```

## Schema Diffing

```typescript
const diff = db.diff();
// { users: { added: ['bio'], removed: ['legacy'], typeChanged: [] } }
```

## Lifecycle Hooks

```typescript
const db = new Database(':memory:', { users: UserSchema }, {
    hooks: {
        users: {
            beforeInsert: (data) => ({ ...data, name: data.name.trim() }),
            afterInsert: (entity) => console.log('Created:', entity.id),
            beforeUpdate: (id, data) => data,
            afterUpdate: (entity) => {},
            beforeDelete: (id) => true,  // return false to cancel
            afterDelete: (id) => {},
        },
    },
});
```

## Soft Deletes & Timestamps

```typescript
// With softDeletes: true
db.users.delete(1);                                  // sets deletedAt
db.users.select().all();                             // excludes deleted
db.users.select().withTrashed().all();               // includes deleted
db.users.select().onlyTrashed().all();               // only deleted
db.users.restore(1);                                 // un-deletes

// With timestamps: true
user.createdAt;  // auto-set on insert
user.updatedAt;  // auto-bumped on update
```

## Raw SQL

```typescript
db.raw<User>('SELECT * FROM users WHERE score > ?', 50);
db.exec('UPDATE users SET score = 0 WHERE role = ?', 'guest');
```

## Full Feature List

- Zod-powered schema definition & runtime validation
- Auto table creation & migration (add columns)
- Fluent query builder with 10+ operators
- Type-safe select narrowing
- Relationship navigation (lazy proxy + eager loading)
- Soft deletes, timestamps, auto-persist proxy
- Lifecycle hooks (before/after insert/update/delete)
- Aggregates (sum, avg, min, max, count, countGrouped)
- Batch mutations (insertMany, upsertMany, updateAll, deleteAll, findOrCreate)
- Cascade deletes
- Computed/virtual getters
- Data import/export (dump, load, seed)
- Schema diffing
- Transactions
- Pagination
- whereIn/whereNotIn with subquery support
- JSON column auto-serialization
- Unique constraints
- Debug mode (SQL logging)
- Raw SQL escape hatch

## Requirements

- **Bun** ≥ 1.0 (uses `bun:sqlite` native bindings)
- **Zod** ≥ 3.0

## License

MIT
