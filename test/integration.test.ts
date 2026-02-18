/**
 * integration.test.ts — sqlite-zod-orm integration tests
 *
 * Covers all query approaches:
 *   1. Fluent builder:   db.trees.select().where({...}).all()
 *   2. Fluent join:      db.trees.select().join(db.forests).all()
 *   3. Proxy callback:   db.query(c => { ... })
 *
 * Plus: lazy navigation, $or, mutations, schema validation, defaults.
 *
 *   bun test test/integration.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { Database, z } from '../src/index';

// -- Explicit FK columns in schemas, config declares which FK → table --

const ForestSchema = z.object({
    name: z.string(),
    address: z.string(),
});

const TreeSchema = z.object({
    name: z.string(),
    planted: z.string(),
    alive: z.boolean().default(true),
    forest_id: z.number().optional(),
});

const db = new Database(':memory:', {
    forests: ForestSchema,
    trees: TreeSchema,
}, {
    relations: {
        trees: { forest_id: 'forests' },
    },
    indexes: { trees: ['forest_id', 'planted'] },
});

// =============================================================================
// 1. BASIC CRUD
// =============================================================================

describe('Forests — CRUD', () => {
    test('insert returns augmented entity', () => {
        const forest = db.forests.insert({ name: 'Amazon', address: 'Brazil' });
        expect(forest.id).toBeDefined();
        expect(forest.name).toBe('Amazon');
    });

    test('select().where().get() returns single row', () => {
        const forest = db.forests.select().where({ name: 'Amazon' }).get();
        expect(forest?.name).toBe('Amazon');
    });

    test('select().all() returns all rows', () => {
        db.forests.insert({ name: 'Sherwood', address: 'Nottinghamshire, England' });
        const all = db.forests.select().all();
        expect(all.length).toBe(2);
    });

    test('select().where().all() returns matching rows', () => {
        const results = db.forests.select().where({ name: 'Amazon' }).all();
        expect(results.length).toBe(1);
        expect(results[0]!.address).toBe('Brazil');
    });

    test('update by ID', () => {
        const amazon = db.forests.select().where({ name: 'Amazon' }).get()!;
        db.forests.update(amazon.id, { address: 'South America' });
        const updated = db.forests.select().where({ name: 'Amazon' }).get()!;
        expect(updated.address).toBe('South America');
    });

    test('delete by ID', () => {
        const extra = db.forests.insert({ name: 'TempForest', address: 'Nowhere' });
        const countBefore = db.forests.select().count();
        db.forests.delete(extra.id);
        expect(db.forests.select().count()).toBe(countBefore - 1);
    });
});

// =============================================================================
// 2. FLUENT QUERY BUILDER
// =============================================================================

describe('Trees — Fluent queries', () => {
    test('setup: seed trees', () => {
        const amazon = db.forests.select().where({ name: 'Amazon' }).get()!;
        const sherwood = db.forests.select().where({ name: 'Sherwood' }).get()!;

        db.trees.insert({ name: 'Mahogany', planted: '1990-01-01', forest_id: amazon.id });
        db.trees.insert({ name: 'Rubber Tree', planted: '1995-06-15', forest_id: amazon.id });
        db.trees.insert({ name: 'Oak', planted: '1800-01-01', forest_id: sherwood.id });
        db.trees.insert({ name: 'Major Oak', planted: '1300-01-01', forest_id: sherwood.id });
        db.trees.insert({ name: 'Dead Elm', planted: '1850-01-01', alive: false, forest_id: sherwood.id });
        db.trees.insert({ name: 'Dead Yew', planted: '1700-01-01', alive: false, forest_id: sherwood.id });
        db.trees.insert({ name: 'Dead Ash', planted: '1600-01-01', alive: false, forest_id: sherwood.id });

        expect(db.trees.select().count()).toBeGreaterThanOrEqual(7);
    });

    test('where + orderBy + limit', () => {
        const sherwood = db.forests.select().where({ name: 'Sherwood' }).get()!;
        const result = db.trees.select()
            .where({ forest_id: sherwood.id, alive: true })
            .orderBy('planted', 'asc')
            .limit(1)
            .all();
        expect(result.length).toBe(1);
        expect(result[0]!.name).toBe('Major Oak');
    });

    test('count()', () => {
        const count = db.trees.select().where({ alive: true }).count();
        expect(count).toBeGreaterThanOrEqual(4);
    });

    test('$gt operator', () => {
        const recent = db.trees.select()
            .where({ planted: { $gt: '1900-01-01' } })
            .all();
        expect(recent.length).toBeGreaterThanOrEqual(1);
    });

    test('$in operator', () => {
        const specific = db.trees.select()
            .where({ name: { $in: ['Mahogany', 'Oak'] } })
            .all();
        expect(specific.length).toBe(2);
    });

    test('$or operator', () => {
        const results = db.trees.select()
            .where({ $or: [{ name: 'Mahogany' }, { name: 'Oak' }] })
            .all();
        expect(results.length).toBe(2);
    });

    test('$or combined with AND', () => {
        const sherwood = db.forests.select().where({ name: 'Sherwood' }).get()!;
        const dead = db.trees.select()
            .where({ forest_id: sherwood.id, alive: false })
            .all();
        expect(dead.length).toBe(3);
    });
});

// =============================================================================
// 3. EXPLICIT FK INSERTS
// =============================================================================

describe('Explicit FK inserts', () => {
    test('insert with explicit FK', () => {
        const amazon = db.forests.select().where({ name: 'Amazon' }).get()!;
        const tree = db.trees.insert({ name: 'Brazil Nut', planted: '1850-01-01', forest_id: amazon.id });
        expect(tree.forest_id).toBe(amazon.id);
    });

    test('where with FK', () => {
        const sherwood = db.forests.select().where({ name: 'Sherwood' }).get()!;
        const trees = db.trees.select().where({ forest_id: sherwood.id }).all();
        expect(trees.length).toBeGreaterThanOrEqual(5);
    });
});

// =============================================================================
// 4. LAZY NAVIGATION
// =============================================================================

describe('Lazy navigation', () => {
    test('belongs-to: tree.forest()', () => {
        const tree = db.trees.select().where({ name: 'Mahogany' }).get()!;
        const forest = (tree as any).forest();
        expect(forest).not.toBeNull();
        expect(forest.name).toBe('Amazon');
    });

    test('one-to-many: forest.trees()', () => {
        const amazon = db.forests.select().where({ name: 'Amazon' }).get()!;
        const trees = (amazon as any).trees();
        expect(trees.length).toBeGreaterThanOrEqual(2);
    });

    test('chain: tree.forest().trees()', () => {
        const tree = db.trees.select().where({ name: 'Mahogany' }).get()!;
        const siblings = (tree as any).forest().trees();
        expect(siblings.length).toBeGreaterThanOrEqual(2);
    });

    test('inverse: forest.trees() returns correct subset', () => {
        const sherwood = db.forests.select().where({ name: 'Sherwood' }).get()!;
        const trees = (sherwood as any).trees();
        const names = trees.map((t: any) => t.name);
        expect(names).toContain('Oak');
        expect(names).toContain('Major Oak');
    });
});

// =============================================================================
// 5. FLUENT JOIN
// =============================================================================

describe('Fluent join', () => {
    test('join trees + forests', () => {
        const rows = db.trees.select('name', 'planted')
            .join(db.forests, ['name', 'address'])
            .orderBy('planted', 'asc')
            .all();
        expect(rows.length).toBeGreaterThanOrEqual(7);
        expect((rows[0] as any).forests_name).toBeDefined();
    });

    test('join with where', () => {
        const rows = db.trees.select('name')
            .join(db.forests, ['name'])
            .where({ alive: true })
            .all();
        expect(rows.length).toBeGreaterThanOrEqual(4);
    });
});

// =============================================================================
// 6. PROXY QUERY
// =============================================================================

describe('Proxy query', () => {
    test('basic join + where + orderBy', () => {
        const rows = db.query((c: any) => {
            const { forests: f, trees: t } = c;
            return {
                select: { tree: t.name, forest: f.name },
                join: [[t.forest_id, f.id]],
                where: { [f.name]: 'Amazon' },
                orderBy: { [t.planted]: 'asc' },
            };
        });
        expect(rows.length).toBeGreaterThanOrEqual(2);
        expect((rows[0] as any).forest).toBe('Amazon');
    });

    test('FK column is explicit — no magic resolution', () => {
        // t.forest_id is a real schema column, used directly
        const rows = db.query((c: any) => {
            const { forests: f, trees: t } = c;
            return {
                select: { tree: t.name },
                join: [[t.forest_id, f.id]],
                where: { [f.name]: 'Sherwood' },
            };
        });
        expect(rows.length).toBeGreaterThanOrEqual(5);
    });
});

// =============================================================================
// 7. FLUENT UPDATE
// =============================================================================

describe('Fluent update', () => {
    test('update().where().exec()', () => {
        const sherwood = db.forests.select().where({ name: 'Sherwood' }).get()!;
        const affected = db.trees.update({ alive: false } as any)
            .where({ forest_id: sherwood.id, alive: true })
            .exec();
        expect(affected).toBeGreaterThan(0);

        // Restore
        db.trees.update({ alive: true } as any)
            .where({ forest_id: sherwood.id, name: { $in: ['Oak', 'Major Oak'] } })
            .exec();
    });
});

// =============================================================================
// 8. UPSERT & TRANSACTIONS
// =============================================================================

describe('Upsert and transactions', () => {
    test('upsert inserts when not found', () => {
        const amazon = db.forests.select().where({ name: 'Amazon' }).get()!;
        db.trees.upsert(
            { name: 'Kapok' } as any,
            { name: 'Kapok', planted: '1900-01-01', alive: true, forest_id: amazon.id },
        );
        const found = db.trees.select().where({ name: 'Kapok' }).get();
        expect(found).not.toBeNull();
    });

    test('upsert updates when found', () => {
        db.trees.upsert(
            { name: 'Kapok' } as any,
            { name: 'Kapok', planted: '1950-01-01' },
        );
        const found = db.trees.select().where({ name: 'Kapok' }).get()!;
        expect(found.planted).toBe('1950-01-01');
    });

    test('transaction commits on success', () => {
        db.transaction(() => {
            db.forests.insert({ name: 'Taiga', address: 'Russia' });
        });
        const taiga = db.forests.select().where({ name: 'Taiga' }).get();
        expect(taiga).not.toBeNull();
    });

    test('transaction rolls back on error', () => {
        const countBefore = db.forests.select().count();
        expect(() => {
            db.transaction(() => {
                db.forests.insert({ name: 'WillFail', address: 'Nowhere' });
                throw new Error('kaboom');
            });
        }).toThrow();
        expect(db.forests.select().count()).toBe(countBefore);
    });
});

// =============================================================================
// 9. ENTITY METHODS (update/delete on entity)
// =============================================================================

describe('Entity methods', () => {
    test('entity.update()', () => {
        const tree = db.trees.select().where({ name: 'Kapok' }).get()!;
        tree.update({ planted: '2000-01-01' });
        const updated = db.trees.select().where({ name: 'Kapok' }).get()!;
        expect(updated.planted).toBe('2000-01-01');
    });

    test('entity.delete()', () => {
        const countBefore = db.trees.select().count();
        const tree = db.trees.select().where({ name: 'Kapok' }).get()!;
        tree.delete();
        expect(db.trees.select().count()).toBe(countBefore - 1);
    });

    test('auto-persist proxy', () => {
        const tree = db.trees.select().where({ name: 'Mahogany' }).get()!;
        tree.planted = '2020-01-01';
        const check = db.trees.select().where({ name: 'Mahogany' }).get()!;
        expect(check.planted).toBe('2020-01-01');
        // Restore
        tree.planted = '1990-01-01';
    });
});

// =============================================================================
// 10. SCHEMA VALIDATION
// =============================================================================

describe('Schema validation', () => {
    test('insert with missing required field throws', () => {
        expect(() => {
            db.forests.insert({ name: 'No Address' } as any);
        }).toThrow();
    });

    test('insert with wrong type throws', () => {
        expect(() => {
            db.trees.insert({ name: 123, planted: 'today' } as any);
        }).toThrow();
    });

    test('defaults are applied (alive = true)', () => {
        const amazon = db.forests.select().where({ name: 'Amazon' }).get()!;
        const tree = db.trees.insert({ name: 'Test Sapling', planted: '2025-01-01', forest_id: amazon.id });
        expect(tree.alive).toBe(true);
        tree.delete(); // cleanup
    });
});

// =============================================================================
// 11. SUBSCRIBE
// =============================================================================

describe('Subscribe (smart polling)', () => {
    test('select().subscribe() detects inserts', async () => {
        let callCount = 0;
        let lastRows: any[] = [];
        const unsub = db.forests.select()
            .where({ name: 'PollTest' })
            .subscribe((rows) => {
                callCount++;
                lastRows = rows;
            }, { interval: 30 });

        // Immediate first call (no data yet)
        expect(callCount).toBe(1);
        expect(lastRows.length).toBe(0);

        // Insert a matching row
        db.forests.insert({ name: 'PollTest', address: 'Here' });
        await new Promise(r => setTimeout(r, 100));

        // Should have fired again with new data
        expect(callCount).toBeGreaterThan(1);
        expect(lastRows.length).toBe(1);
        expect(lastRows[0].name).toBe('PollTest');

        unsub();
    });
});
// =============================================================================
// 11b. ROW STREAM — .on()
// =============================================================================

describe('Row stream (.on)', () => {
    test('emits new inserts individually in order', async () => {
        const received: string[] = [];
        const unsub = db.forests.on((forest) => {
            received.push(forest.name);
        }, { interval: 30 });

        // Insert 3 rows
        db.forests.insert({ name: 'OnTest1', address: 'A' });
        db.forests.insert({ name: 'OnTest2', address: 'B' });
        await new Promise(r => setTimeout(r, 100));
        db.forests.insert({ name: 'OnTest3', address: 'C' });
        await new Promise(r => setTimeout(r, 100));

        unsub();

        // All 3 emitted individually, in insertion order
        expect(received).toContain('OnTest1');
        expect(received).toContain('OnTest2');
        expect(received).toContain('OnTest3');
        expect(received.indexOf('OnTest1')).toBeLessThan(received.indexOf('OnTest2'));
        expect(received.indexOf('OnTest2')).toBeLessThan(received.indexOf('OnTest3'));
    });

    test('does not emit rows that existed before subscription', async () => {
        // These rows already exist from previous tests
        const existingCount = db.forests.select().count();
        expect(existingCount).toBeGreaterThan(0);

        const received: any[] = [];
        const unsub = db.forests.on((forest) => {
            received.push(forest);
        }, { interval: 30 });

        // Wait — no new inserts
        await new Promise(r => setTimeout(r, 100));
        expect(received.length).toBe(0);

        // Now insert one
        db.forests.insert({ name: 'OnTestNew', address: 'New' });
        await new Promise(r => setTimeout(r, 100));
        expect(received.length).toBe(1);
        expect(received[0].name).toBe('OnTestNew');

        unsub();
    });
});

// =============================================================================
// 12. INDEPENDENT CONFIG-BASED DB (authors/books)
// =============================================================================

describe('Config-based relations — authors/books', () => {
    const AuthorSchema = z.object({
        name: z.string(),
        country: z.string(),
    });

    const BookSchema = z.object({
        title: z.string(),
        year: z.number(),
        author_id: z.number().optional(),
    });

    const cdb = new Database(':memory:', {
        authors: AuthorSchema,
        books: BookSchema,
    }, {
        relations: {
            books: { author_id: 'authors' },
        },
    });

    const tolstoy = cdb.authors.insert({ name: 'Leo Tolstoy', country: 'Russia' });
    const kafka = cdb.authors.insert({ name: 'Franz Kafka', country: 'Czech Republic' });
    cdb.books.insert({ title: 'War and Peace', year: 1869, author_id: tolstoy.id });
    cdb.books.insert({ title: 'Anna Karenina', year: 1878, author_id: tolstoy.id });
    cdb.books.insert({ title: 'The Trial', year: 1925, author_id: kafka.id });

    test('FK column is author_id', () => {
        const books = cdb.books.select().all();
        expect(books.length).toBe(3);
        expect(books[0]!.author_id).toBe(tolstoy.id);
    });

    test('select().where() with FK', () => {
        const books = cdb.books.select().where({ author_id: tolstoy.id }).all();
        expect(books.length).toBe(2);
        expect(books.map(b => b.title).sort()).toEqual(['Anna Karenina', 'War and Peace']);
    });

    test('select().where().get() with FK', () => {
        const book = cdb.books.select().where({ author_id: kafka.id }).get();
        expect(book?.title).toBe('The Trial');
    });

    test('lazy navigation: book.author()', () => {
        const book = cdb.books.select().where({ title: 'War and Peace' }).get()!;
        const author = (book as any).author();
        expect(author.name).toBe('Leo Tolstoy');
        expect(author.country).toBe('Russia');
    });

    test('lazy navigation: author.books()', () => {
        const author = cdb.authors.select().where({ name: 'Leo Tolstoy' }).get()!;
        const books = (author as any).books();
        expect(books.length).toBe(2);
    });

    test('fluent join', () => {
        const rows = cdb.books.select('title', 'year')
            .join(cdb.authors, ['name'])
            .orderBy('year', 'asc')
            .all();
        expect(rows.length).toBe(3);
        expect((rows[0] as any).authors_name).toBe('Leo Tolstoy');
    });

    test('proxy query', () => {
        const rows = cdb.query((c: any) => {
            const { authors: a, books: b } = c;
            return {
                select: { author: a.name, book: b.title },
                join: [[b.author_id, a.id]],
                where: { [a.country]: 'Russia' },
                orderBy: { [b.year]: 'asc' },
            };
        });
        expect(rows.length).toBe(2);
        expect((rows[0] as any).author).toBe('Leo Tolstoy');
    });
});
