// test/query-builder.test.ts

import { describe, it, expect, beforeAll } from 'bun:test';
import { SatiDB, z } from '../src/satidb';

// ---------- Schema Definitions ----------

const ForestSchema = z.object({
    name: z.string(),
    region: z.string(),
    trees: z.lazy(() => z.array(TreeSchema)).optional(),
});

const TreeSchema = z.object({
    species: z.string(),
    height: z.number(),
    plantedAt: z.date().optional(),
    forestId: z.number().optional(),
    forest: z.lazy(() => ForestSchema).optional(),
});

describe('SatiDB - Fluent Query Builder API', () => {
    let db: SatiDB<{ forests: typeof ForestSchema; trees: typeof TreeSchema }>;

    beforeAll(() => {
        db = new SatiDB(':memory:', {
            forests: ForestSchema,
            trees: TreeSchema,
        });

        // Seed data
        const amazon = db.forests.insert({ name: 'Amazon', region: 'South America' });
        const blackForest = db.forests.insert({ name: 'Black Forest', region: 'Europe' });
        const redwood = db.forests.insert({ name: 'Redwood', region: 'North America' });

        db.trees.insert({ species: 'Brazil Nut', height: 50, forestId: amazon.id, plantedAt: new Date('2020-01-15') });
        db.trees.insert({ species: 'Rubber Tree', height: 30, forestId: amazon.id, plantedAt: new Date('2019-06-01') });
        db.trees.insert({ species: 'Spruce', height: 40, forestId: blackForest.id, plantedAt: new Date('2018-03-10') });
        db.trees.insert({ species: 'Oak', height: 25, forestId: blackForest.id, plantedAt: new Date('2021-09-20') });
        db.trees.insert({ species: 'Coast Redwood', height: 115, forestId: redwood.id, plantedAt: new Date('2015-11-05') });
        db.trees.insert({ species: 'Giant Sequoia', height: 85, forestId: redwood.id, plantedAt: new Date('2017-04-22') });
    });

    // ---- select() basic ----

    it('should return all rows with select().all()', () => {
        const trees = db.trees.select().all();
        expect(trees.length).toBe(6);
    });

    it('should return a single row with select().get()', () => {
        const tree = db.trees.select().where({ species: 'Spruce' }).get();
        expect(tree).not.toBeNull();
        expect(tree?.species).toBe('Spruce');
        expect(tree?.height).toBe(40);
    });

    it('should return null with .get() when nothing matches', () => {
        const tree = db.trees.select().where({ species: 'Baobab' }).get();
        expect(tree).toBeNull();
    });

    // ---- where() ----

    it('should filter with simple equality', () => {
        const trees = db.trees.select().where({ forestId: 1 }).all();
        expect(trees.length).toBe(2);
        expect(trees.every(t => t.forestId === 1)).toBe(true);
    });

    it('should filter with $gt operator', () => {
        const tallTrees = db.trees.select().where({ height: { $gt: 50 } }).all();
        expect(tallTrees.length).toBe(2);
        expect(tallTrees.every(t => t.height > 50)).toBe(true);
    });

    it('should filter with $gte operator', () => {
        const trees = db.trees.select().where({ height: { $gte: 50 } }).all();
        expect(trees.length).toBe(3); // 50, 85, 115
    });

    it('should filter with $lt operator', () => {
        const shortTrees = db.trees.select().where({ height: { $lt: 35 } }).all();
        expect(shortTrees.length).toBe(2); // 30, 25
    });

    it('should filter with $ne operator', () => {
        const nonSpruce = db.trees.select().where({ species: { $ne: 'Spruce' } }).all();
        expect(nonSpruce.length).toBe(5);
        expect(nonSpruce.every(t => t.species !== 'Spruce')).toBe(true);
    });

    it('should filter with $in operator', () => {
        const trees = db.trees.select().where({ species: { $in: ['Oak', 'Spruce'] } }).all();
        expect(trees.length).toBe(2);
        const species = trees.map(t => t.species).sort();
        expect(species).toEqual(['Oak', 'Spruce']);
    });

    it('should handle $in with empty array', () => {
        const trees = db.trees.select().where({ species: { $in: [] } }).all();
        expect(trees.length).toBe(0);
    });

    it('should combine multiple where conditions (AND)', () => {
        const trees = db.trees.select()
            .where({ forestId: 1, height: { $gt: 40 } })
            .all();
        expect(trees.length).toBe(1);
        expect(trees[0]!.species).toBe('Brazil Nut');
    });

    // ---- limit() & offset() ----

    it('should limit results', () => {
        const trees = db.trees.select().limit(3).all();
        expect(trees.length).toBe(3);
    });

    it('should support offset for pagination', () => {
        const page1 = db.trees.select().orderBy('height', 'asc').limit(2).all();
        const page2 = db.trees.select().orderBy('height', 'asc').limit(2).offset(2).all();

        expect(page1.length).toBe(2);
        expect(page2.length).toBe(2);
        // Page 1 and page 2 should be different
        expect(page1[0]!.height).not.toBe(page2[0]!.height);
    });

    // ---- orderBy() ----

    it('should order by ascending', () => {
        const trees = db.trees.select().orderBy('height', 'asc').all();
        for (let i = 1; i < trees.length; i++) {
            expect(trees[i]!.height).toBeGreaterThanOrEqual(trees[i - 1]!.height);
        }
    });

    it('should order by descending', () => {
        const trees = db.trees.select().orderBy('height', 'desc').all();
        for (let i = 1; i < trees.length; i++) {
            expect(trees[i]!.height).toBeLessThanOrEqual(trees[i - 1]!.height);
        }
    });

    // ---- Chaining combination ----

    it('should support full chain: select().where().orderBy().limit().all()', () => {
        const trees = db.trees.select()
            .where({ height: { $gte: 30 } })
            .orderBy('height', 'desc')
            .limit(3)
            .all();

        expect(trees.length).toBe(3);
        expect(trees[0]!.species).toBe('Coast Redwood'); // tallest
        for (let i = 1; i < trees.length; i++) {
            expect(trees[i]!.height).toBeLessThanOrEqual(trees[i - 1]!.height);
        }
    });

    // ---- raw() mode ----

    it('should return raw rows without augmented methods when raw() is used', () => {
        const trees = db.trees.select().raw().limit(1).all();
        expect(trees.length).toBe(1);
        // Raw rows should NOT have .update() or .delete() methods
        expect(typeof (trees[0] as any).update).not.toBe('function');
        expect(typeof (trees[0] as any).delete).not.toBe('function');
    });

    it('should return augmented entities by default (non-raw)', () => {
        const trees = db.trees.select().limit(1).all();
        expect(trees.length).toBe(1);
        // Augmented entities should have .update() and .delete()
        expect(typeof trees[0]?.update).toBe('function');
        expect(typeof trees[0]?.delete).toBe('function');
    });

    // ---- count() ----

    it('should count all records', () => {
        const count = db.trees.select().count();
        expect(count).toBe(6);
    });

    it('should count with where conditions', () => {
        const count = db.trees.select().where({ forestId: 1 }).count();
        expect(count).toBe(2);
    });

    // ---- Thenable (await) support ----

    it('should be awaitable with then()', async () => {
        const trees = await db.trees.select().where({ height: { $gt: 80 } });
        expect(trees.length).toBe(2);
        const species = trees.map(t => t.species).sort();
        expect(species).toEqual(['Coast Redwood', 'Giant Sequoia']);
    });

    // ---- Forests (testing on second table) ----

    it('should work with forests table too', () => {
        const forests = db.forests.select().orderBy('name', 'asc').all();
        expect(forests.length).toBe(3);
        expect(forests[0]!.name).toBe('Amazon');
        expect(forests[1]!.name).toBe('Black Forest');
        expect(forests[2]!.name).toBe('Redwood');
    });

    it('should filter forests by region', () => {
        const european = db.forests.select().where({ region: 'Europe' }).all();
        expect(european.length).toBe(1);
        expect(european[0]!.name).toBe('Black Forest');
    });
});
