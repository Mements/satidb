/**
 * v315-features.test.ts — Tests for v3.15 features
 *
 * Select type narrowing. Compile-time correctness is verified by tsc --noEmit.
 */
import { describe, test, expect } from 'bun:test';
import { Database, z } from '../src/index';

const UserSchema = z.object({
    name: z.string(),
    email: z.string(),
    role: z.string().default('member'),
    score: z.number().default(0),
});

describe('select type narrowing', () => {
    test('select specific columns returns only those columns', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', email: 'a@co.com', score: 100 });
        db.users.insert({ name: 'Bob', email: 'b@co.com', score: 50 });

        // Only name and email columns selected
        const results = db.users.select('name', 'email').all();
        expect(results.length).toBe(2);
        expect(results[0]!.name).toBe('Alice');
        expect(results[0]!.email).toBe('a@co.com');

        // At runtime, only selected columns are returned
        const keys = Object.keys(results[0]!);
        expect(keys).toContain('name');
        expect(keys).toContain('email');
        expect(keys).not.toContain('score');
        expect(keys).not.toContain('role');
        db.close();
    });

    test('select with id includes id column', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', email: 'a@co.com' });

        const results = db.users.select('id', 'name').all();
        expect(results[0]!.id).toBeGreaterThan(0);
        expect(results[0]!.name).toBe('Alice');
        db.close();
    });

    test('select() with no args returns all columns', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', email: 'a@co.com', score: 100 });

        const results = db.users.select().all();
        expect(results[0]!.name).toBe('Alice');
        expect(results[0]!.email).toBe('a@co.com');
        expect(results[0]!.score).toBe(100);
        expect(results[0]!.role).toBe('member');
        db.close();
    });

    test('narrowed get() returns narrowed type', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', email: 'a@co.com' });

        const user = db.users.select('name').where({ id: 1 }).get();
        expect(user).not.toBeNull();
        expect(user!.name).toBe('Alice');
        // user should not have 'email' at runtime
        expect(Object.keys(user!)).not.toContain('email');
        db.close();
    });

    test('narrowed first() returns narrowed type', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', email: 'a@co.com' });

        const user = db.users.select('email').first();
        expect(user).not.toBeNull();
        expect(user!.email).toBe('a@co.com');
        db.close();
    });

    test('narrowed paginate() returns narrowed data', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insertMany([
            { name: 'Alice', email: 'a@co.com' },
            { name: 'Bob', email: 'b@co.com' },
        ]);

        const page = db.users.select('name').paginate(1, 10);
        expect(page.data.length).toBe(2);
        expect(page.data[0]!.name).toBe('Alice');
        expect(Object.keys(page.data[0]!)).not.toContain('email');
        db.close();
    });

    test('where() still uses full entity keys after select', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insertMany([
            { name: 'Alice', email: 'a@co.com', score: 100 },
            { name: 'Bob', email: 'b@co.com', score: 50 },
        ]);

        // select only name but filter on score (not selected)
        const results = db.users.select('name')
            .where({ score: { $gt: 60 } })
            .all();
        expect(results.length).toBe(1);
        expect(results[0]!.name).toBe('Alice');
        db.close();
    });

    // ---- Compile-time type checks ----
    // These verify the types at compile time via tsc --noEmit.
    // If the types are wrong, tsc will fail.
    test('compile-time: narrowed types are correct', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', email: 'a@co.com' });

        // Full select: has all fields
        const full = db.users.select().get()!;
        const _checkName: string = full.name;
        const _checkEmail: string = full.email;
        const _checkRole: string = full.role;
        const _checkScore: number = full.score;

        // Narrowed select: only has name
        const narrow = db.users.select('name').get()!;
        const _checkNarrowName: string = narrow.name;
        // @ts-expect-error — email should not exist on narrowed type
        const _shouldFail = narrow.email;

        db.close();
    });
});
