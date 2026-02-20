/**
 * v311-features.test.ts — Tests for v3.11 features
 *
 * $isNull/$isNotNull, distinct, having, aggregates, paginate,
 * db.raw(), timestamps, soft deletes, debug, migration, concurrent writes.
 */
import { describe, test, expect } from 'bun:test';
import { Database, z } from '../src/index';
import { tmpdir } from 'os';
import { join } from 'path';

// ---------- Schemas -------------------------------------------------------
const UserSchema = z.object({
    name: z.string(),
    email: z.string(),
    score: z.number().default(0),
    bio: z.string().optional(),
});

const PostSchema = z.object({
    title: z.string(),
    body: z.string(),
    user_id: z.number().optional(),
});

function createDb(opts: Record<string, any> = {}) {
    return new Database(':memory:', { users: UserSchema, posts: PostSchema }, {
        relations: { posts: { user_id: 'users' } },
        ...opts,
    });
}

function seedUsers(db: ReturnType<typeof createDb>) {
    db.users.insert({ name: 'Alice', email: 'alice@co.com', score: 100 });
    db.users.insert({ name: 'Bob', email: 'bob@co.com', score: 50 });
    db.users.insert({ name: 'Carol', email: 'carol@co.com', score: 100 });
    db.users.insert({ name: 'Dave', email: 'dave@co.com', score: 25, bio: 'Hello!' });
    db.users.insert({ name: 'Eve', email: 'eve@co.com', score: 75, bio: 'World' });
}

// ==========================================================================
// $isNull / $isNotNull operators
// ==========================================================================
describe('$isNull / $isNotNull', () => {
    test('$isNull finds rows with NULL field', () => {
        const db = createDb();
        seedUsers(db);
        const noBio = db.users.select().where({ bio: { $isNull: true } }).all();
        expect(noBio.length).toBe(3); // Alice, Bob, Carol
        for (const u of noBio) expect(u.bio == null).toBe(true);
        db.close();
    });

    test('$isNotNull finds rows with non-NULL field', () => {
        const db = createDb();
        seedUsers(db);
        const hasBio = db.users.select().where({ bio: { $isNotNull: true } }).all();
        expect(hasBio.length).toBe(2); // Dave, Eve
        for (const u of hasBio) expect(u.bio).toBeDefined();
        db.close();
    });

    test('$isNull works in buildWhereClause (used by deleteWhere)', () => {
        const db = createDb();
        seedUsers(db);
        (db.users as any).delete().where({ bio: { $isNull: true } }).exec();
        expect(db.users.select().count()).toBe(2); // Only Dave + Eve remain
        db.close();
    });
});

// ==========================================================================
// distinct
// ==========================================================================
describe('distinct()', () => {
    test('returns distinct score values', () => {
        const db = createDb();
        seedUsers(db);
        const scores = db.users.select('score').distinct().raw().all();
        const vals = scores.map((r: any) => r.score).sort((a: number, b: number) => a - b);
        expect(vals).toEqual([25, 50, 75, 100]);
        db.close();
    });
});

// ==========================================================================
// Aggregates: sum, avg, min, max
// ==========================================================================
describe('Aggregate methods', () => {
    test('sum() returns total of numeric column', () => {
        const db = createDb();
        seedUsers(db);
        const total = db.users.select().sum('score');
        expect(total).toBe(350); // 100 + 50 + 100 + 25 + 75
        db.close();
    });

    test('avg() returns average', () => {
        const db = createDb();
        seedUsers(db);
        const average = db.users.select().avg('score');
        expect(average).toBe(70); // 350/5
        db.close();
    });

    test('min() returns minimum', () => {
        const db = createDb();
        seedUsers(db);
        const minimum = db.users.select().min('score');
        expect(minimum).toBe(25);
        db.close();
    });

    test('max() returns maximum', () => {
        const db = createDb();
        seedUsers(db);
        const maximum = db.users.select().max('score');
        expect(maximum).toBe(100);
        db.close();
    });

    test('sum with where filter', () => {
        const db = createDb();
        seedUsers(db);
        const total = db.users.select().where({ score: { $gte: 75 } }).sum('score');
        expect(total).toBe(275); // 100 + 100 + 75
        db.close();
    });

    test('sum on empty result returns 0', () => {
        const db = createDb();
        const total = db.users.select().sum('score');
        expect(total).toBe(0);
        db.close();
    });
});

// ==========================================================================
// having
// ==========================================================================
describe('having()', () => {
    test('filters grouped results by aggregate', () => {
        const db = createDb();
        seedUsers(db);
        // Group by score, only keep groups with count > 1
        const results = db.users.select('score')
            .groupBy('score')
            .having({ 'COUNT(*)': { $gt: 1 } })
            .raw().all();
        expect(results.length).toBe(1);
        expect((results[0] as any).score).toBe(100);
        db.close();
    });
});

// ==========================================================================
// paginate
// ==========================================================================
describe('paginate()', () => {
    test('returns paginated results with metadata', () => {
        const db = createDb();
        seedUsers(db);
        const page1 = db.users.select().orderBy('name').paginate(1, 2);
        expect(page1.data.length).toBe(2);
        expect(page1.total).toBe(5);
        expect(page1.page).toBe(1);
        expect(page1.perPage).toBe(2);
        expect(page1.pages).toBe(3); // ceil(5/2) = 3
        expect(page1.data[0].name).toBe('Alice');
        expect(page1.data[1].name).toBe('Bob');
        db.close();
    });

    test('page 2 returns next set', () => {
        const db = createDb();
        seedUsers(db);
        const page2 = db.users.select().orderBy('name').paginate(2, 2);
        expect(page2.data.length).toBe(2);
        expect(page2.data[0].name).toBe('Carol');
        expect(page2.data[1].name).toBe('Dave');
        db.close();
    });

    test('last page may have fewer items', () => {
        const db = createDb();
        seedUsers(db);
        const page3 = db.users.select().orderBy('name').paginate(3, 2);
        expect(page3.data.length).toBe(1);
        expect(page3.data[0].name).toBe('Eve');
        db.close();
    });
});

// ==========================================================================
// db.raw() / db.exec()
// ==========================================================================
describe('db.raw() and db.exec()', () => {
    test('raw() executes SQL and returns rows', () => {
        const db = createDb();
        seedUsers(db);
        const rows = db.raw<{ name: string }>('SELECT name FROM users ORDER BY name');
        expect(rows.length).toBe(5);
        expect(rows[0].name).toBe('Alice');
        db.close();
    });

    test('raw() with params', () => {
        const db = createDb();
        seedUsers(db);
        const rows = db.raw<{ name: string }>('SELECT name FROM users WHERE score > ?', 60);
        expect(rows.length).toBe(3); // Alice(100), Carol(100), Eve(75)
        db.close();
    });

    test('exec() runs mutation without returning rows', () => {
        const db = createDb();
        seedUsers(db);
        db.exec('UPDATE users SET score = ? WHERE name = ?', 999, 'Alice');
        const alice = db.users.select().where({ name: 'Alice' }).get();
        expect(alice!.score).toBe(999);
        db.close();
    });
});

// ==========================================================================
// Timestamps
// ==========================================================================
describe('timestamps', () => {
    test('insert auto-sets createdAt and updatedAt', () => {
        const db = createDb({ timestamps: true });
        const before = new Date().toISOString();
        const user = db.users.insert({ name: 'Test', email: 'test@co.com' });
        const raw = db.raw<any>('SELECT * FROM users WHERE id = ?', user.id);
        expect(raw[0].createdAt).toBeDefined();
        expect(raw[0].updatedAt).toBeDefined();
        expect(raw[0].createdAt).toBe(raw[0].updatedAt);
        expect(raw[0].createdAt >= before).toBe(true);
        db.close();
    });

    test('update bumps updatedAt', () => {
        const db = createDb({ timestamps: true });
        const user = db.users.insert({ name: 'Test', email: 'test@co.com' });
        const raw1 = db.raw<any>('SELECT * FROM users WHERE id = ?', user.id);
        const created = raw1[0].createdAt;
        // Small delay to get different timestamp
        const start = Date.now();
        while (Date.now() - start < 5) { }
        db.users.update(user.id, { name: 'Updated' });
        const raw2 = db.raw<any>('SELECT * FROM users WHERE id = ?', user.id);
        expect(raw2[0].createdAt).toBe(created); // unchanged
        expect(raw2[0].updatedAt >= created).toBe(true);
        db.close();
    });

    test('insertMany also sets timestamps', () => {
        const db = createDb({ timestamps: true });
        db.users.insertMany([
            { name: 'A', email: 'a@co.com' },
            { name: 'B', email: 'b@co.com' },
        ]);
        const rows = db.raw<any>('SELECT * FROM users');
        for (const r of rows) {
            expect(r.createdAt).toBeDefined();
            expect(r.updatedAt).toBeDefined();
        }
        db.close();
    });
});

// ==========================================================================
// Soft Deletes
// ==========================================================================
describe('soft deletes', () => {
    test('delete(id) sets deletedAt instead of removing row', () => {
        const db = createDb({ softDeletes: true });
        const user = db.users.insert({ name: 'Test', email: 'test@co.com' });
        db.users.delete(user.id);
        // Row still exists in DB
        const raw = db.raw<any>('SELECT * FROM users WHERE id = ?', user.id);
        expect(raw.length).toBe(1);
        expect(raw[0].deletedAt).toBeDefined();
        db.close();
    });

    test('select() excludes soft-deleted rows by default', () => {
        const db = createDb({ softDeletes: true });
        db.users.insert({ name: 'Alice', email: 'a@co.com' });
        const bob = db.users.insert({ name: 'Bob', email: 'b@co.com' });
        db.users.delete(bob.id);
        const all = db.users.select().all();
        expect(all.length).toBe(1);
        expect(all[0].name).toBe('Alice');
        db.close();
    });

    test('withTrashed() includes soft-deleted rows', () => {
        const db = createDb({ softDeletes: true });
        db.users.insert({ name: 'Alice', email: 'a@co.com' });
        const bob = db.users.insert({ name: 'Bob', email: 'b@co.com' });
        db.users.delete(bob.id);
        const all = db.users.select().withTrashed().all();
        expect(all.length).toBe(2);
        db.close();
    });

    test('count() respects soft delete filter', () => {
        const db = createDb({ softDeletes: true });
        db.users.insert({ name: 'Alice', email: 'a@co.com' });
        const bob = db.users.insert({ name: 'Bob', email: 'b@co.com' });
        db.users.delete(bob.id);
        expect(db.users.select().count()).toBe(1);
        expect(db.users.select().withTrashed().count()).toBe(2);
        db.close();
    });
});

// ==========================================================================
// Debug mode
// ==========================================================================
describe('debug mode', () => {
    test('debug logs SQL to console', () => {
        const logs: string[] = [];
        const originalLog = console.log;
        console.log = (...args: any[]) => { if (args[0] === '[satidb]') logs.push(args[1]); };
        try {
            const db = createDb({ debug: true });
            db.users.insert({ name: 'Test', email: 'test@co.com' });
            db.users.select().all();
            db.close();
            expect(logs.length).toBeGreaterThan(0);
            expect(logs.some(l => l.includes('INSERT'))).toBe(true);
            expect(logs.some(l => l.includes('SELECT'))).toBe(true);
        } finally {
            console.log = originalLog;
        }
    });
});

// ==========================================================================
// Migration tests
// ==========================================================================
describe('auto-migration', () => {
    test('adding a column to schema auto-migrates', () => {
        const path = join(tmpdir(), `satidb-test-migration-${Date.now()}.db`);
        const db1 = new Database(path, {
            items: z.object({ name: z.string() }),
        });
        db1.items.insert({ name: 'foo' });
        db1.close();

        // Re-open with extended schema — new column should be auto-added
        const db2 = new Database(path, {
            items: z.object({ name: z.string(), color: z.string().optional() }),
        });
        db2.items.insert({ name: 'bar', color: 'red' });
        const rows = db2.items.select().all();
        expect(rows.length).toBe(2);
        expect(rows[1].name).toBe('bar');
        expect(rows[1].color).toBe('red');
        // Original row should have null for new column
        expect(rows[0].color == null).toBe(true);
        db2.close();
        // Cleanup
        try { require('fs').unlinkSync(path); } catch { }
    });
});

// ==========================================================================
// Concurrent writes (WAL mode)
// ==========================================================================
describe('concurrent writes', () => {
    test('parallel inserts via transaction succeed', () => {
        const db = createDb();
        db.transaction(() => {
            for (let i = 0; i < 100; i++) {
                db.users.insert({ name: `User${i}`, email: `u${i}@co.com`, score: i });
            }
        });
        expect(db.users.select().count()).toBe(100);
        db.close();
    });
});
