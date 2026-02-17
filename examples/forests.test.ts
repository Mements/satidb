/**
 * forests.test.ts — sqlite-zod-orm integration tests
 *
 * Covers all three query approaches:
 *   1. Fluent builder:   db.trees.select().where({...}).all()
 *   2. Fluent join:      db.trees.select().join(db.forests).all()
 *   3. Proxy callback:   db.query(c => { ... })
 *
 * Plus: relationships, mutations, schema validation, computed fields.
 *
 *   bun test examples/forests.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { createForestsDb } from './forests';

const { db, displayName } = createForestsDb();

// =============================================================================
// 1. SEED — insert via relationship .push()
// =============================================================================

describe('Forests — Seed', () => {
    test('create forests and add trees via relationship', () => {
        // Insert forests
        const sherwood = db.forests.insert({ name: 'Sherwood', address: 'Nottingham, UK' });
        const amazon = db.forests.insert({ name: 'Amazon', address: 'South America' });
        const blackForest = db.forests.insert({ name: 'Black Forest', address: 'Baden-Württemberg, DE' });

        // Add trees via one-to-many relationship — auto-sets forestId
        (sherwood as any).trees.push({ name: 'Major Oak', planted: '1500-01-01' });
        (sherwood as any).trees.push({ name: 'Robin Hood Oak', planted: '1600-03-15' });
        (sherwood as any).trees.push({ name: 'Dead Elm', planted: '1700-06-01', alive: false });

        (amazon as any).trees.push({ name: 'Brazil Nut', planted: '1800-01-01' });
        (amazon as any).trees.push({ name: 'Rubber Tree', planted: '1850-05-20' });
        (amazon as any).trees.push({ name: 'Kapok', planted: '1900-09-10' });

        (blackForest as any).trees.push({ name: 'Silver Fir', planted: '1920-04-01' });
        (blackForest as any).trees.push({ name: 'Norway Spruce', planted: '1950-07-15' });

        expect(db.forests.select().count()).toBe(3);
        expect(db.trees.select().count()).toBe(8);
    });
});

// =============================================================================
// 2. TABLE-LEVEL QUERIES — db.trees.select() / db.trees.get()
// =============================================================================

describe('Forests — Table-level queries', () => {
    test('get single tree by filter', () => {
        const tree = db.trees.select().where({ name: 'Major Oak' }).get()!;
        expect(tree).not.toBeNull();
        expect(tree.name).toBe('Major Oak');
        expect(tree.alive).toBe(true);
    });

    test('get tree with multiple conditions', () => {
        const tree = db.trees.get({ alive: true, name: 'Major Oak' } as any);
        expect(tree).not.toBeNull();
    });

    test('find all alive trees', () => {
        const alive = db.trees.select().where({ alive: true }).all();
        expect(alive.length).toBe(7);
    });

    test('find dead trees', () => {
        const dead = db.trees.select().where({ alive: false }).all();
        expect(dead.length).toBe(1);
        expect(dead[0]!.name).toBe('Dead Elm');
    });

    test('find trees planted after 1800, sorted by date', () => {
        const trees = db.trees.select()
            .where({ planted: { $gte: '1800-01-01' } })
            .orderBy('planted', 'asc')
            .all();

        expect(trees.length).toBe(5);
        expect(trees[0]!.name).toBe('Brazil Nut');
        expect(trees[4]!.name).toBe('Norway Spruce');
    });

    test('paginate trees', () => {
        const page1 = db.trees.select().orderBy('id', 'asc').limit(3).all();
        const page2 = db.trees.select().orderBy('id', 'asc').limit(3).offset(3).all();

        expect(page1.length).toBe(3);
        expect(page2.length).toBe(3);
        expect(page1[0]!.name).not.toBe(page2[0]!.name);
    });

    test('count trees per forest using relationship', () => {
        const sherwood = db.forests.select().where({ name: 'Sherwood' }).get()!;
        const count = (sherwood as any).trees.find().length;
        expect(count).toBe(3);
    });
});

// =============================================================================
// 3. COMPUTED FIELDS — plain functions, no DSL
// =============================================================================

describe('Forests — Computed fields', () => {
    test('displayName concatenates name and address', () => {
        const forest = db.forests.select().where({ name: 'Sherwood' }).get()!;
        expect(displayName(forest)).toBe('Sherwood - Nottingham, UK');
    });

    test('displayName for all forests', () => {
        const all = db.forests.select().orderBy('id', 'asc').all();
        expect(all.map(displayName)).toEqual([
            'Sherwood - Nottingham, UK',
            'Amazon - South America',
            'Black Forest - Baden-Württemberg, DE',
        ]);
    });
});

// =============================================================================
// 4. RELATIONSHIP NAVIGATION — belongs-to / one-to-many
// =============================================================================

describe('Forests — Relationship navigation', () => {
    test('tree → forest (belongs-to)', () => {
        const tree = db.trees.select().where({ name: 'Major Oak' }).get()!;
        const forest = (tree as any).forest();
        expect(forest.name).toBe('Sherwood');
        expect(forest.address).toBe('Nottingham, UK');
    });

    test('forest → trees (one-to-many)', () => {
        const amazon = db.forests.select().where({ name: 'Amazon' }).get()!;
        const trees = (amazon as any).trees.find();
        expect(trees.length).toBe(3);
        const names = trees.map((t: any) => t.name).sort();
        expect(names).toEqual(['Brazil Nut', 'Kapok', 'Rubber Tree']);
    });

    test('add tree via relationship, then navigate back', () => {
        const blackForest = db.forests.select().where({ name: 'Black Forest' }).get()!;
        const newTree = (blackForest as any).trees.push({
            name: 'European Beech',
            planted: '2020-03-21',
        });

        // Navigate back: new tree → forest
        const forest = newTree.forest();
        expect(forest.name).toBe('Black Forest');
    });
});

// =============================================================================
// 5. PROXY QUERY — db.query(c => {...}) for SQL-like JOINs
// =============================================================================

describe('Forests — Proxy query (SQL-like JOINs)', () => {
    test('join trees with forest name', () => {
        const rows = db.query((c: any) => {
            const { forests: f, trees: t } = c;
            return {
                select: { tree: t.name, forest: f.name, planted: t.planted },
                join: [[t.forestId, f.id]],
                where: { [f.name]: 'Sherwood' },
                orderBy: { [t.planted]: 'asc' },
            };
        });

        expect(rows.length).toBe(3);
        expect((rows[0] as any).tree).toBe('Major Oak');
        expect((rows[0] as any).forest).toBe('Sherwood');
        expect((rows[2] as any).tree).toBe('Dead Elm');
    });

    test('join with WHERE IN filter', () => {
        const rows = db.query((c: any) => {
            const { forests: f, trees: t } = c;
            return {
                select: { tree: t.name, forest: f.name },
                join: [[t.forestId, f.id]],
                where: { [t.id]: { $in: [1, 2, 3] } },
            };
        });

        expect(rows.length).toBe(3);
        expect(rows.every((r: any) => r.forest === 'Sherwood')).toBe(true);
    });

    test('join: all alive trees across all forests', () => {
        const rows = db.query((c: any) => {
            const { forests: f, trees: t } = c;
            return {
                select: { tree: t.name, forest: f.name, alive: t.alive },
                join: [[t.forestId, f.id]],
                where: { [t.alive]: 1 },
                orderBy: { [f.name]: 'asc', [t.name]: 'asc' },
            };
        });

        // All alive trees should have forest names
        expect(rows.every((r: any) => typeof r.forest === 'string')).toBe(true);
        expect(rows.every((r: any) => r.alive === 1)).toBe(true);
    });

    test('join: count trees per forest (manual grouping)', () => {
        const rows = db.query((c: any) => {
            const { forests: f, trees: t } = c;
            return {
                select: { forest: f.name, tree: t.name },
                join: [[t.forestId, f.id]],
            };
        });

        const byForest: Record<string, number> = {};
        for (const r of rows as any[]) {
            byForest[r.forest] = (byForest[r.forest] || 0) + 1;
        }

        expect(byForest['Sherwood']).toBe(3);
        expect(byForest['Amazon']).toBe(3);
        expect(byForest['Black Forest']).toBe(3);  // 2 original + 1 added in relationship test
    });
});

// =============================================================================
// 5b. FLUENT JOIN — db.trees.select().join().where().all()
//     Same power as proxy query, simpler syntax for common joins.
// =============================================================================

describe('Forests — Fluent join (select().join())', () => {
    test('join trees with forest name + address (auto FK)', () => {
        // db.forests is the accessor — FK auto-inferred from z.lazy relationship
        const rows = db.trees.select('name', 'planted')
            .join(db.forests, ['name', 'address'])
            .where({ alive: true })
            .orderBy('planted', 'asc')
            .all();

        expect(rows.length).toBeGreaterThan(0);
        // Joined columns are prefixed: forests_name, forests_address
        expect((rows[0] as any).forests_name).toBeDefined();
        expect((rows[0] as any).forests_address).toBeDefined();
    });

    test('join with where filter on FK', () => {
        const sherwood = db.forests.select().where({ name: 'Sherwood' }).get()!;
        const rows = db.trees.select('name')
            .join(db.forests, ['name'])
            .where({ forestId: sherwood.id } as any)
            .all();

        expect(rows.length).toBe(3);
        expect(rows.every((r: any) => r.forests_name === 'Sherwood')).toBe(true);
    });

    test('join with orderBy and limit', () => {
        const rows = db.trees.select('name', 'planted')
            .join(db.forests, ['name'])
            .orderBy('planted', 'desc')
            .limit(3)
            .all();

        expect(rows.length).toBe(3);
        // Most recently planted trees first
        expect((rows[0] as any).planted >= (rows[1] as any).planted).toBe(true);
    });

    test('string-based join still works (manual FK)', () => {
        const rows = db.trees.select('name')
            .join('forests', 'forestId', ['name'])
            .all();

        expect(rows.length).toBeGreaterThan(0);
        expect((rows[0] as any).forests_name).toBeDefined();
    });
});


// =============================================================================
// 6. MUTATIONS — update, upsert, delete
// =============================================================================

describe('Forests — Mutations', () => {
    test('update tree by ID', () => {
        const elm = db.trees.select().where({ name: 'Dead Elm' }).get()!;
        db.trees.update(elm.id, { alive: true });  // resurrect!
        const updated = db.trees.get(elm.id)!;
        expect(updated.alive).toBe(true);
    });

    test('fluent update: mark all Sherwood trees as dead', () => {
        const sherwood = db.forests.select().where({ name: 'Sherwood' }).get()!;
        const affected = db.trees.update({ alive: false } as any)
            .where({ forestId: sherwood.id } as any)
            .exec();

        expect(affected).toBe(3);
        const dead = db.trees.select().where({ forestId: sherwood.id, alive: false } as any).all();
        expect(dead.length).toBe(3);
    });

    test('upsert tree', () => {
        const amazon = db.forests.select().where({ name: 'Amazon' }).get()!;
        db.trees.upsert(
            { name: 'Brazil Nut' },
            { name: 'Brazil Nut', planted: '1800-01-01', alive: true, forestId: amazon.id } as any,
        );

        // Should not duplicate
        const nuts = db.trees.select().where({ name: 'Brazil Nut' }).all();
        expect(nuts.length).toBe(1);
    });

    test('delete tree', () => {
        const countBefore = db.trees.select().count();
        const elm = db.trees.select().where({ name: 'Dead Elm' }).get()!;
        db.trees.delete(elm.id);
        expect(db.trees.select().count()).toBe(countBefore - 1);
    });
});

// =============================================================================
// 7. SCHEMA VALIDATION — Zod enforces types at runtime
// =============================================================================

describe('Forests — Schema validation', () => {
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
        const tree = (amazon as any).trees.push({ name: 'Test Sapling', planted: '2025-01-01' });
        expect(tree.alive).toBe(true);  // default applied by Zod
    });
});
