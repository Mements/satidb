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
// 11. CHANGE LISTENERS — db.table.on()
// =============================================================================

describe('Change listeners (on)', () => {
    test('on("insert") fires for new rows', async () => {
        const received: string[] = [];
        const unsub = db.forests.on('insert', (forest) => {
            received.push(forest.name);
        });

        db.forests.insert({ name: 'OnInsert1', address: 'A' });
        db.forests.insert({ name: 'OnInsert2', address: 'B' });

        // Wait for poller to pick up changes
        await new Promise(r => setTimeout(r, 200));

        expect(received).toContain('OnInsert1');
        expect(received).toContain('OnInsert2');
        expect(received.indexOf('OnInsert1')).toBeLessThan(received.indexOf('OnInsert2'));

        unsub();
    });

    test('on("update") fires for updated rows', async () => {
        const forest = db.forests.insert({ name: 'OnUpdate1', address: 'Before' });

        const received: string[] = [];
        const unsub = db.forests.on('update', (row) => {
            received.push(row.address);
        });

        db.forests.update(forest.id, { address: 'After' });
        await new Promise(r => setTimeout(r, 200));

        expect(received).toContain('After');
        unsub();
    });

    test('on("delete") fires with { id } for deleted rows', async () => {
        const forest = db.forests.insert({ name: 'OnDelete1', address: 'X' });

        const received: number[] = [];
        const unsub = db.forests.on('delete', (row) => {
            received.push(row.id);
        });

        db.forests.delete(forest.id);
        await new Promise(r => setTimeout(r, 200));

        expect(received).toContain(forest.id);
        unsub();
    });

    test('unsubscribe stops listener', async () => {
        const received: string[] = [];
        const unsub = db.forests.on('insert', (forest) => {
            received.push(forest.name);
        });

        db.forests.insert({ name: 'BeforeUnsub', address: 'A' });
        await new Promise(r => setTimeout(r, 200));
        expect(received.length).toBe(1);

        unsub();

        db.forests.insert({ name: 'AfterUnsub', address: 'B' });
        await new Promise(r => setTimeout(r, 200));
        // Should still be 1 — listener was removed
        expect(received.length).toBe(1);
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

    test('where with entity reference', () => {
        const books = cdb.books.select().where({ author: tolstoy } as any).all();
        expect(books.length).toBe(2);
        expect(books.map((b: any) => b.title).sort()).toEqual(['Anna Karenina', 'War and Peace']);
    });

    test('join + where with entity reference (enriched query)', () => {
        const rows = cdb.books.select('title', 'year')
            .join(cdb.authors, ['name', 'country'])
            .where({ author: tolstoy } as any)
            .orderBy('year', 'asc')
            .all();
        expect(rows.length).toBe(2);
        expect((rows[0] as any).title).toBe('War and Peace');
        expect((rows[0] as any).authors_name).toBe('Leo Tolstoy');
        expect((rows[0] as any).authors_country).toBe('Russia');
        expect((rows[1] as any).title).toBe('Anna Karenina');
    });

    test('join + where with dot-qualified joined column', () => {
        const rows = cdb.books.select('title')
            .join(cdb.authors, ['name', 'country'])
            .where({ 'authors.country': 'Czech Republic' } as any)
            .all();
        expect(rows.length).toBe(1);
        expect((rows[0] as any).title).toBe('The Trial');
        expect((rows[0] as any).authors_country).toBe('Czech Republic');
    });

    test('.with() eager loading — single author', () => {
        const tolstoyWithBooks = cdb.authors.select().where({ name: 'Leo Tolstoy' }).with('books').get()! as any;
        expect(tolstoyWithBooks.name).toBe('Leo Tolstoy');
        expect(tolstoyWithBooks.books).toBeDefined();
        expect(tolstoyWithBooks.books.length).toBe(2);
        expect(tolstoyWithBooks.books.map((b: any) => b.title).sort()).toEqual(['Anna Karenina', 'War and Peace']);
    });

    test('.with() eager loading — all authors', () => {
        const authors = cdb.authors.select().with('books').all() as any[];
        expect(authors.length).toBe(2);

        const t = authors.find((a: any) => a.name === 'Leo Tolstoy')!;
        const k = authors.find((a: any) => a.name === 'Franz Kafka')!;
        expect(t.books.length).toBe(2);
        expect(k.books.length).toBe(1);
        expect(k.books[0].title).toBe('The Trial');
    });

    test('.with() eager loading — children are augmented entities', () => {
        const author = cdb.authors.select().where({ name: 'Franz Kafka' }).with('books').get()! as any;
        const book = author.books[0];
        expect(typeof book.update).toBe('function');
        expect(typeof book.delete).toBe('function');
    });

    test('.with() — entity with no children gets empty array', () => {
        const newAuthor = cdb.authors.insert({ name: 'Unknown Author', country: 'N/A' });
        const loaded = cdb.authors.select().where({ id: newAuthor.id }).with('books').get()! as any;
        expect(loaded.books).toBeDefined();
        expect(loaded.books.length).toBe(0);
        newAuthor.delete(); // cleanup
    });
});
