/**
 * v323-features.test.ts — Tests for v3.23 features
 *
 * increment(), decrement(), distinct() (extended coverage).
 */
import { describe, test, expect } from 'bun:test';
import { Database, z } from '../src/index';

const UserSchema = z.object({
    name: z.string(),
    role: z.string().default('guest'),
    score: z.number().default(0),
});

// ==========================================================================
// increment
// ==========================================================================
describe('increment', () => {
    test('increments a column by 1 (default)', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', score: 10 });
        const affected = db.users.select().where({ name: 'Alice' }).increment('score');
        expect(affected).toBe(1);
        const user = db.users.select().where({ name: 'Alice' }).first()!;
        expect(user.score).toBe(11);
        db.close();
    });

    test('increments by custom amount', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', score: 10 });
        db.users.select().where({ name: 'Alice' }).increment('score', 25);
        const user = db.users.select().where({ name: 'Alice' }).first()!;
        expect(user.score).toBe(35);
        db.close();
    });

    test('increments multiple matching rows', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', role: 'vip', score: 10 });
        db.users.insert({ name: 'Bob', role: 'vip', score: 20 });
        db.users.insert({ name: 'Charlie', role: 'guest', score: 5 });

        const affected = db.users.select().where({ role: 'vip' }).increment('score', 100);
        expect(affected).toBe(2);

        const alice = db.users.select().where({ name: 'Alice' }).first()!;
        const bob = db.users.select().where({ name: 'Bob' }).first()!;
        const charlie = db.users.select().where({ name: 'Charlie' }).first()!;
        expect(alice.score).toBe(110);
        expect(bob.score).toBe(120);
        expect(charlie.score).toBe(5); // untouched
        db.close();
    });
});

// ==========================================================================
// decrement
// ==========================================================================
describe('decrement', () => {
    test('decrements a column by 1 (default)', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', score: 10 });
        db.users.select().where({ name: 'Alice' }).decrement('score');
        const user = db.users.select().where({ name: 'Alice' }).first()!;
        expect(user.score).toBe(9);
        db.close();
    });

    test('decrements by custom amount', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', score: 100 });
        db.users.select().where({ name: 'Alice' }).decrement('score', 30);
        const user = db.users.select().where({ name: 'Alice' }).first()!;
        expect(user.score).toBe(70);
        db.close();
    });
});

// ==========================================================================
// distinct (already existed, coverage)
// ==========================================================================
describe('distinct', () => {
    test('returns unique rows only', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', role: 'admin' });
        db.users.insert({ name: 'Bob', role: 'admin' });
        db.users.insert({ name: 'Charlie', role: 'guest' });

        const roles = db.users.select('role').distinct().all();
        expect(roles).toHaveLength(2);
        db.close();
    });

    test('distinct pluck returns unique values', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', role: 'admin', score: 100 });
        db.users.insert({ name: 'Bob', role: 'admin', score: 50 });
        db.users.insert({ name: 'Charlie', role: 'guest', score: 75 });

        // distinct() + select('role') + pluck should give unique roles
        const roles = db.users.select('role').distinct().all().map(r => r.role);
        expect(roles.sort()).toEqual(['admin', 'guest']);
        db.close();
    });
});
