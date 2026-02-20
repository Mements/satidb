/**
 * v313-features.test.ts — Tests for v3.13 features
 *
 * Lifecycle hooks, upsertMany, countGrouped.
 */
import { describe, test, expect } from 'bun:test';
import { Database, z } from '../src/index';

const UserSchema = z.object({
    name: z.string(),
    email: z.string(),
    role: z.string().default('member'),
    score: z.number().default(0),
});

// ==========================================================================
// Lifecycle Hooks
// ==========================================================================
describe('lifecycle hooks', () => {
    test('beforeInsert can transform data', () => {
        const db = new Database(':memory:', { users: UserSchema }, {
            hooks: {
                users: {
                    beforeInsert: (data) => ({ ...data, name: data.name.toUpperCase() }),
                },
            },
        });
        const user = db.users.insert({ name: 'alice', email: 'a@co.com' });
        expect(user.name).toBe('ALICE');
        db.close();
    });

    test('afterInsert fires with the persisted entity', () => {
        const log: any[] = [];
        const db = new Database(':memory:', { users: UserSchema }, {
            hooks: {
                users: {
                    afterInsert: (entity) => log.push({ id: entity.id, name: entity.name }),
                },
            },
        });
        db.users.insert({ name: 'Alice', email: 'a@co.com' });
        db.users.insert({ name: 'Bob', email: 'b@co.com' });
        expect(log.length).toBe(2);
        expect(log[0]!.name).toBe('Alice');
        expect(log[1]!.name).toBe('Bob');
        db.close();
    });

    test('beforeUpdate can transform data', () => {
        const db = new Database(':memory:', { users: UserSchema }, {
            hooks: {
                users: {
                    beforeUpdate: (data, _id) => ({ ...data, name: data.name?.toUpperCase() }),
                },
            },
        });
        const user = db.users.insert({ name: 'Alice', email: 'a@co.com' });
        db.users.update(user.id, { name: 'bob' });
        const updated = db.users.select().where({ id: user.id }).get();
        expect(updated!.name).toBe('BOB');
        db.close();
    });

    test('afterUpdate fires with updated entity', () => {
        const log: any[] = [];
        const db = new Database(':memory:', { users: UserSchema }, {
            hooks: {
                users: {
                    afterUpdate: (entity) => log.push(entity.name),
                },
            },
        });
        const user = db.users.insert({ name: 'Alice', email: 'a@co.com' });
        db.users.update(user.id, { name: 'Bob' });
        expect(log.length).toBe(1);
        expect(log[0]).toBe('Bob');
        db.close();
    });

    test('beforeDelete can cancel deletion', () => {
        const db = new Database(':memory:', { users: UserSchema }, {
            hooks: {
                users: {
                    beforeDelete: (_id) => false, // always cancel
                },
            },
        });
        const user = db.users.insert({ name: 'Alice', email: 'a@co.com' });
        db.users.delete(user.id);
        // Should still exist because delete was cancelled
        expect(db.users.select().count()).toBe(1);
        db.close();
    });

    test('afterDelete fires after deletion', () => {
        const deletedIds: number[] = [];
        const db = new Database(':memory:', { users: UserSchema }, {
            hooks: {
                users: {
                    afterDelete: (id) => deletedIds.push(id),
                },
            },
        });
        const user = db.users.insert({ name: 'Alice', email: 'a@co.com' });
        db.users.delete(user.id);
        expect(deletedIds).toEqual([user.id]);
        db.close();
    });

    test('hooks fire on insertMany', () => {
        const names: string[] = [];
        const db = new Database(':memory:', { users: UserSchema }, {
            hooks: {
                users: {
                    beforeInsert: (data) => ({ ...data, name: data.name.toUpperCase() }),
                    afterInsert: (entity) => names.push(entity.name),
                },
            },
        });
        db.users.insertMany([
            { name: 'alice', email: 'a@co.com' },
            { name: 'bob', email: 'b@co.com' },
        ]);
        expect(names).toEqual(['ALICE', 'BOB']);
        db.close();
    });

    test('hooks fire on soft delete', () => {
        const deletedIds: number[] = [];
        const db = new Database(':memory:', { users: UserSchema }, {
            softDeletes: true,
            hooks: {
                users: {
                    afterDelete: (id) => deletedIds.push(id),
                },
            },
        });
        const user = db.users.insert({ name: 'Alice', email: 'a@co.com' });
        db.users.delete(user.id);
        expect(deletedIds).toEqual([user.id]);
        // Row is soft deleted, not hard deleted
        expect(db.users.select().withTrashed().count()).toBe(1);
        db.close();
    });
});

// ==========================================================================
// upsertMany
// ==========================================================================
describe('upsertMany', () => {
    test('inserts new rows in batch', () => {
        const db = new Database(':memory:', { users: UserSchema });
        const results = db.users.upsertMany([
            { name: 'Alice', email: 'a@co.com' },
            { name: 'Bob', email: 'b@co.com' },
        ]);
        expect(results.length).toBe(2);
        expect(db.users.select().count()).toBe(2);
        db.close();
    });

    test('updates existing rows in batch', () => {
        const db = new Database(':memory:', { users: UserSchema });
        const alice = db.users.insert({ name: 'Alice', email: 'a@co.com', score: 10 });
        const bob = db.users.insert({ name: 'Bob', email: 'b@co.com', score: 20 });
        // Upsert with id updates existing
        const results = db.users.upsertMany([
            { id: alice.id, name: 'Alice2', email: 'a@co.com', score: 100 },
            { id: bob.id, name: 'Bob2', email: 'b@co.com', score: 200 },
        ] as any[]);
        expect(results.length).toBe(2);
        expect(results[0]!.name).toBe('Alice2');
        expect(results[1]!.name).toBe('Bob2');
        expect(db.users.select().count()).toBe(2); // no new rows
        db.close();
    });

    test('returns empty array for empty input', () => {
        const db = new Database(':memory:', { users: UserSchema });
        expect(db.users.upsertMany([])).toEqual([]);
        db.close();
    });
});

// ==========================================================================
// countGrouped
// ==========================================================================
describe('countGrouped', () => {
    test('counts rows per group', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insertMany([
            { name: 'Alice', email: 'a@co.com', role: 'admin' },
            { name: 'Bob', email: 'b@co.com', role: 'member' },
            { name: 'Carol', email: 'c@co.com', role: 'admin' },
            { name: 'Dave', email: 'd@co.com', role: 'member' },
            { name: 'Eve', email: 'e@co.com', role: 'member' },
        ]);
        const grouped = db.users.select('role')
            .groupBy('role')
            .countGrouped();
        expect(grouped.length).toBe(2);
        const adminGroup = grouped.find(g => g.role === 'admin');
        const memberGroup = grouped.find(g => g.role === 'member');
        expect(adminGroup!.count).toBe(2);
        expect(memberGroup!.count).toBe(3);
        db.close();
    });

    test('throws without groupBy', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insert({ name: 'Alice', email: 'a@co.com' });
        expect(() => db.users.select('role').countGrouped()).toThrow('groupBy');
        db.close();
    });

    test('respects where clause', () => {
        const db = new Database(':memory:', { users: UserSchema });
        db.users.insertMany([
            { name: 'Alice', email: 'a@co.com', role: 'admin', score: 100 },
            { name: 'Bob', email: 'b@co.com', role: 'member', score: 50 },
            { name: 'Carol', email: 'c@co.com', role: 'admin', score: 200 },
            { name: 'Dave', email: 'd@co.com', role: 'member', score: 10 },
        ]);
        const grouped = db.users.select('role')
            .where({ score: { $gt: 30 } })
            .groupBy('role')
            .countGrouped();
        const adminGroup = grouped.find(g => g.role === 'admin');
        const memberGroup = grouped.find(g => g.role === 'member');
        expect(adminGroup!.count).toBe(2);
        expect(memberGroup!.count).toBe(1); // only Bob has score > 30
        db.close();
    });
});
