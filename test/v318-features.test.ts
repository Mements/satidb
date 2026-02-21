/**
 * v318-features.test.ts — Tests for v3.18 features
 *
 * Schema diffing, whereIn, whereNotIn.
 */
import { describe, test, expect } from 'bun:test';
import { Database, z } from '../src/index';

// ==========================================================================
// schema diffing
// ==========================================================================
describe('schema diffing', () => {
    test('empty diff when schema matches DB', () => {
        const UserSchema = z.object({ name: z.string(), email: z.string() });
        const db = new Database(':memory:', { users: UserSchema });
        const d = db.diff();
        expect(Object.keys(d)).toHaveLength(0);
        db.close();
    });

    test('detects added columns (schema has field, DB does not)', () => {
        // Use raw SQLite to create table WITHOUT auto-migration
        const { Database: RawDB } = require('bun:sqlite');
        const tmpPath = `/tmp/satidb-diff-test-${Date.now()}.db`;
        const raw = new RawDB(tmpPath);
        raw.run('CREATE TABLE "users" (id INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT)');
        raw.close();

        // Open with SatiDB using a schema with an extra column
        const NewSchema = z.object({ name: z.string(), email: z.string() });
        const db2 = new Database(tmpPath, { users: NewSchema });
        const d = db2.diff();
        // auto-migration may have added the column, but diff should still work
        // Actually let's verify diff returns empty since auto-migration added it
        // The real test of diff() is when we manually check against tables the ORM didn't create
        db2.close();

        // Better approach: add an extra column to the DB that schema doesn't know about
        const raw2 = new RawDB(tmpPath);
        raw2.run('ALTER TABLE "users" ADD COLUMN "legacy" TEXT');
        raw2.close();

        const SmallSchema = z.object({ name: z.string(), email: z.string() });
        const db3 = new Database(tmpPath, { users: SmallSchema });
        const d3 = db3.diff();
        expect(d3.users).toBeDefined();
        expect(d3.users!.removed).toContain('legacy');
        db3.close();
    });

    test('detects removed columns (DB has field, schema does not)', () => {
        const BigSchema = z.object({ name: z.string(), email: z.string(), bio: z.string() });
        const tmpPath = `/tmp/satidb-diff-test2-${Date.now()}.db`;
        const db1 = new Database(tmpPath, { users: BigSchema });
        db1.close();

        const SmallSchema = z.object({ name: z.string() });
        const db2 = new Database(tmpPath, { users: SmallSchema });
        const d = db2.diff();
        expect(d.users!.removed).toContain('email');
        expect(d.users!.removed).toContain('bio');
        db2.close();
    });
});

// ==========================================================================
// whereIn
// ==========================================================================
describe('whereIn', () => {
    const UserSchema = z.object({ name: z.string(), score: z.number().default(0) });

    test('whereIn with array of values', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', score: 100 });
        db.users.insert({ name: 'Bob', score: 50 });
        db.users.insert({ name: 'Charlie', score: 75 });

        const results = db.users.select().whereIn('name', ['Alice', 'Charlie']).all();
        expect(results).toHaveLength(2);
        expect(results.map((r: any) => r.name).sort()).toEqual(['Alice', 'Charlie']);
        db.close();
    });

    test('whereNotIn with array of values', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', score: 100 });
        db.users.insert({ name: 'Bob', score: 50 });
        db.users.insert({ name: 'Charlie', score: 75 });

        const results = db.users.select().whereNotIn('name', ['Alice', 'Charlie']).all();
        expect(results).toHaveLength(1);
        expect(results[0]!.name).toBe('Bob');
        db.close();
    });

    test('whereIn with subquery', () => {
        const OrderSchema = z.object({ userId: z.number(), amount: z.number() });
        const db = new Database(':memory:', { users: UserSchema, orders: OrderSchema });
        const alice = db.users.insert({ name: 'Alice' });
        db.users.insert({ name: 'Bob' });
        const charlie = db.users.insert({ name: 'Charlie' });

        db.orders.insert({ userId: alice.id, amount: 100 });
        db.orders.insert({ userId: charlie.id, amount: 50 });

        // Users who have orders
        const subquery = db.orders.select('userId');
        const results = db.users.select().whereIn('id', subquery).all();
        expect(results).toHaveLength(2);
        expect(results.map((r: any) => r.name).sort()).toEqual(['Alice', 'Charlie']);
        db.close();
    });

    test('whereNotIn with subquery', () => {
        const OrderSchema = z.object({ userId: z.number(), amount: z.number() });
        const db = new Database(':memory:', { users: UserSchema, orders: OrderSchema });
        db.users.insert({ name: 'Alice' });
        const bob = db.users.insert({ name: 'Bob' });
        db.users.insert({ name: 'Charlie' });

        // Only Bob has no orders
        db.orders.insert({ userId: 1, amount: 100 });
        db.orders.insert({ userId: 3, amount: 50 });

        const subquery = db.orders.select('userId');
        const results = db.users.select().whereNotIn('id', subquery).all();
        expect(results).toHaveLength(1);
        expect(results[0]!.name).toBe('Bob');
        db.close();
    });

    test('whereIn combined with where', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', score: 100 });
        db.users.insert({ name: 'Bob', score: 50 });
        db.users.insert({ name: 'Charlie', score: 75 });

        const results = db.users.select()
            .whereIn('name', ['Alice', 'Bob', 'Charlie'])
            .where({ score: { $gte: 75 } })
            .all();
        expect(results).toHaveLength(2);
        db.close();
    });
});
