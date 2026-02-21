/**
 * v319-features.test.ts — Tests for v3.19 features
 *
 * Batch updateAll/deleteAll, transaction API (existed, now tested),
 * aggregates (existed, now tested more).
 */
import { describe, test, expect } from 'bun:test';
import { Database, z } from '../src/index';

const UserSchema = z.object({
    name: z.string(),
    role: z.string().default('guest'),
    score: z.number().default(0),
});

// ==========================================================================
// updateAll
// ==========================================================================
describe('updateAll', () => {
    test('batch updates matching rows', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', role: 'guest', score: 10 });
        db.users.insert({ name: 'Bob', role: 'guest', score: 20 });
        db.users.insert({ name: 'Charlie', role: 'admin', score: 30 });

        const affected = db.users.select().where({ role: 'guest' }).updateAll({ role: 'member' });
        expect(affected).toBe(2);
        expect(db.users.select().where({ role: 'member' }).count()).toBe(2);
        expect(db.users.select().where({ role: 'admin' }).count()).toBe(1);
        db.close();
    });

    test('updateAll with multiple set fields', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', role: 'guest', score: 10 });
        db.users.insert({ name: 'Bob', role: 'guest', score: 20 });

        db.users.select().where({ role: 'guest' }).updateAll({ role: 'vip', score: 999 });
        const users = db.users.select().all();
        expect(users[0]!.role).toBe('vip');
        expect(users[0]!.score).toBe(999);
        expect(users[1]!.role).toBe('vip');
        db.close();
    });

    test('updateAll with no matching rows returns 0', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', role: 'admin' });
        const affected = db.users.select().where({ role: 'nonexistent' }).updateAll({ score: 0 });
        expect(affected).toBe(0);
        db.close();
    });
});

// ==========================================================================
// deleteAll
// ==========================================================================
describe('deleteAll', () => {
    test('batch deletes matching rows', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', role: 'guest' });
        db.users.insert({ name: 'Bob', role: 'guest' });
        db.users.insert({ name: 'Charlie', role: 'admin' });

        const deleted = db.users.select().where({ role: 'guest' }).deleteAll();
        expect(deleted).toBe(2);
        expect(db.users.count()).toBe(1);
        expect(db.users.select().first()!.name).toBe('Charlie');
        db.close();
    });

    test('deleteAll with no matches returns 0', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice' });
        const deleted = db.users.select().where({ role: 'nonexistent' }).deleteAll();
        expect(deleted).toBe(0);
        expect(db.users.count()).toBe(1);
        db.close();
    });

    test('deleteAll with whereIn', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice' });
        db.users.insert({ name: 'Bob' });
        db.users.insert({ name: 'Charlie' });

        const deleted = db.users.select().whereIn('name', ['Alice', 'Bob']).deleteAll();
        expect(deleted).toBe(2);
        expect(db.users.count()).toBe(1);
        db.close();
    });
});

// ==========================================================================
// transaction
// ==========================================================================
describe('transaction', () => {
    test('commits on success', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.transaction(() => {
            db.users.insert({ name: 'Alice' });
            db.users.insert({ name: 'Bob' });
        });
        expect(db.users.count()).toBe(2);
        db.close();
    });

    test('rolls back on error', () => {
        const db = new Database(':memory:', { users: UserSchema });
        try {
            db.transaction(() => {
                db.users.insert({ name: 'Alice' });
                throw new Error('test rollback');
            });
        } catch (e) {
            // expected
        }
        expect(db.users.count()).toBe(0);
        db.close();
    });

    test('returns value from callback', () => {
        const db = new Database(':memory:', { users: UserSchema });
        const result = db.transaction(() => {
            db.users.insert({ name: 'Alice' });
            return db.users.count();
        });
        expect(result).toBe(1);
        db.close();
    });
});

// ==========================================================================
// aggregates (already existed, extended coverage)
// ==========================================================================
describe('aggregates', () => {
    test('sum, avg, min, max', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', score: 100 });
        db.users.insert({ name: 'Bob', score: 50 });
        db.users.insert({ name: 'Charlie', score: 75 });

        expect(db.users.select().sum('score')).toBe(225);
        expect(db.users.select().avg('score')).toBe(75);
        expect(db.users.select().min('score')).toBe(50);
        expect(db.users.select().max('score')).toBe(100);
        db.close();
    });

    test('aggregates with where filter', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', role: 'admin', score: 100 });
        db.users.insert({ name: 'Bob', role: 'guest', score: 50 });
        db.users.insert({ name: 'Charlie', role: 'admin', score: 75 });

        expect(db.users.select().where({ role: 'admin' }).sum('score')).toBe(175);
        expect(db.users.select().where({ role: 'admin' }).avg('score')).toBe(87.5);
        db.close();
    });
});
