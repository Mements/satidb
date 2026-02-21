/**
 * v316-features.test.ts — Tests for v3.16 features
 *
 * count shorthand, computed getters, cascade deletes.
 */
import { describe, test, expect } from 'bun:test';
import { Database, z } from '../src/index';

const UserSchema = z.object({
    first: z.string(),
    last: z.string(),
    email: z.string(),
    score: z.number().default(0),
});

// ==========================================================================
// count() shorthand
// ==========================================================================
describe('count shorthand', () => {
    test('db.users.count() returns total rows', () => {
        const db = new Database(':memory:', { users: UserSchema });
        expect(db.users.count()).toBe(0);
        db.users.insert({ first: 'Alice', last: 'A', email: 'a@co.com' });
        db.users.insert({ first: 'Bob', last: 'B', email: 'b@co.com' });
        expect(db.users.count()).toBe(2);
        db.close();
    });

    test('count() respects softDeletes', () => {
        const db = new Database(':memory:', { users: UserSchema }, { softDeletes: true });
        db.users.insert({ first: 'Alice', last: 'A', email: 'a@co.com' });
        const bob = db.users.insert({ first: 'Bob', last: 'B', email: 'b@co.com' });
        db.users.delete(bob.id);
        expect(db.users.count()).toBe(1); // Bob is soft-deleted
        db.close();
    });
});

// ==========================================================================
// computed getters
// ==========================================================================
describe('computed getters', () => {
    test('virtual field computed from entity data', () => {
        const db = new Database(':memory:', { users: UserSchema }, {
            computed: {
                users: {
                    fullName: (u) => `${u.first} ${u.last}`,
                },
            },
        });
        const user = db.users.insert({ first: 'Alice', last: 'Smith', email: 'a@co.com' });
        expect((user as any).fullName).toBe('Alice Smith');
        db.close();
    });

    test('computed getters update when data changes', () => {
        const db = new Database(':memory:', { users: UserSchema }, {
            computed: {
                users: {
                    fullName: (u) => `${u.first} ${u.last}`,
                },
            },
        });
        const user = db.users.insert({ first: 'Alice', last: 'Smith', email: 'a@co.com' });
        expect((user as any).fullName).toBe('Alice Smith');
        user.first = 'Bob';
        expect((user as any).fullName).toBe('Bob Smith');
        db.close();
    });

    test('computed getters on queried entities', () => {
        const db = new Database(':memory:', { users: UserSchema }, {
            computed: {
                users: {
                    initials: (u) => `${u.first[0]}${u.last[0]}`,
                    isHighScore: (u) => u.score > 50,
                },
            },
        });
        db.users.insert({ first: 'Alice', last: 'Smith', email: 'a@co.com', score: 100 });
        const user = db.users.select().where({ id: 1 }).get();
        expect((user as any)!.initials).toBe('AS');
        expect((user as any)!.isHighScore).toBe(true);
        db.close();
    });

    test('multiple computed fields', () => {
        const db = new Database(':memory:', { users: UserSchema }, {
            computed: {
                users: {
                    fullName: (u) => `${u.first} ${u.last}`,
                    displayName: (u) => `${u.first} (${u.score} pts)`,
                },
            },
        });
        const user = db.users.insert({ first: 'Alice', last: 'S', email: 'a@co.com', score: 42 });
        expect((user as any).fullName).toBe('Alice S');
        expect((user as any).displayName).toBe('Alice (42 pts)');
        db.close();
    });
});

// ==========================================================================
// cascade deletes
// ==========================================================================
describe('cascade deletes', () => {
    const AuthorSchema = z.object({
        name: z.string(),
    });
    const BookSchema = z.object({
        title: z.string(),
        author_id: z.number(),
    });

    test('deleting parent auto-deletes children', () => {
        const db = new Database(':memory:', { authors: AuthorSchema, books: BookSchema }, {
            relations: { books: { author_id: 'authors' } },
            cascade: { authors: ['books'] },
        });
        const author = db.authors.insert({ name: 'Tolkien' });
        db.books.insert({ title: 'The Hobbit', author_id: author.id });
        db.books.insert({ title: 'LOTR', author_id: author.id });
        expect(db.books.count()).toBe(2);

        db.authors.delete(author.id);
        expect(db.books.count()).toBe(0);
        expect(db.authors.count()).toBe(0);
        db.close();
    });

    test('cascade with softDeletes soft-deletes children', () => {
        const db = new Database(':memory:', { authors: AuthorSchema, books: BookSchema }, {
            relations: { books: { author_id: 'authors' } },
            cascade: { authors: ['books'] },
            softDeletes: true,
        });
        const author = db.authors.insert({ name: 'Tolkien' });
        db.books.insert({ title: 'The Hobbit', author_id: author.id });
        db.books.insert({ title: 'LOTR', author_id: author.id });

        db.authors.delete(author.id);
        // Both author and books should be soft-deleted
        expect(db.authors.count()).toBe(0);
        expect(db.books.count()).toBe(0);
        // But still exist with withTrashed
        expect(db.books.select().withTrashed().count()).toBe(2);
        db.close();
    });

    test('cascade only affects children of deleted parent', () => {
        const db = new Database(':memory:', { authors: AuthorSchema, books: BookSchema }, {
            relations: { books: { author_id: 'authors' } },
            cascade: { authors: ['books'] },
        });
        const tolkien = db.authors.insert({ name: 'Tolkien' });
        const asimov = db.authors.insert({ name: 'Asimov' });
        db.books.insert({ title: 'The Hobbit', author_id: tolkien.id });
        db.books.insert({ title: 'Foundation', author_id: asimov.id });

        db.authors.delete(tolkien.id);
        expect(db.books.count()).toBe(1); // Only Asimov's book remains
        expect(db.books.select().first()!.title).toBe('Foundation');
        db.close();
    });
});
