// test/proxy-query.test.ts

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

describe('SatiDB - Proxy Callback Query API (Midnight Style)', () => {
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

    // ---- Basic proxy query with JOIN ----

    it('should perform a basic JOIN query via proxy callback', () => {
        const results = db.query(c => {
            const { trees: t, forests: f } = c;
            return {
                select: { species: t.species, height: t.height, forest: f.name },
                join: [t.forestId, f.id],
            };
        });

        expect(results.length).toBe(6);
        // All results should have the forest name
        expect(results.every((r: any) => typeof r.forest === 'string')).toBe(true);
    });

    it('should filter with WHERE using computed key (toString trick)', () => {
        const results = db.query(c => {
            const { trees: t, forests: f } = c;
            return {
                select: { species: t.species, forest: f.name },
                join: [t.forestId, f.id],
                where: { [f.name]: 'Amazon' },
            };
        });

        expect(results.length).toBe(2);
        expect(results.every((r: any) => r.forest === 'Amazon')).toBe(true);
        const species = results.map((r: any) => r.species).sort();
        expect(species).toEqual(['Brazil Nut', 'Rubber Tree']);
    });

    it('should support WHERE with literal values', () => {
        const results = db.query(c => {
            const { trees: t } = c;
            return {
                select: { species: t.species, height: t.height },
                where: { [t.height]: { $gt: 80 } },
            };
        });

        expect(results.length).toBe(2);
        expect(results.every((r: any) => r.height > 80)).toBe(true);
    });

    it('should support LIMIT in proxy query', () => {
        const results = db.query(c => {
            const { trees: t } = c;
            return {
                select: { species: t.species },
                limit: 2,
            };
        });

        expect(results.length).toBe(2);
    });

    it('should support ORDER BY in proxy query', () => {
        const results = db.query(c => {
            const { trees: t } = c;
            return {
                select: { species: t.species, height: t.height },
                orderBy: { [t.height]: 'desc' },
            };
        });

        expect(results.length).toBe(6);
        // Should be descending by height
        for (let i = 1; i < results.length; i++) {
            expect((results[i] as any).height).toBeLessThanOrEqual((results[i - 1] as any).height);
        }
    });

    // ---- Single table query (no join) ----

    it('should work without JOIN for single-table queries', () => {
        const results = db.query(c => {
            const { forests: f } = c;
            return {
                select: { name: f.name, region: f.region },
                where: { [f.region]: 'Europe' },
            };
        });

        expect(results.length).toBe(1);
        expect((results[0] as any).name).toBe('Black Forest');
    });

    // ---- Combined features ----

    it('should combine JOIN + WHERE + ORDER BY + LIMIT', () => {
        const results = db.query(c => {
            const { trees: t, forests: f } = c;
            return {
                select: { species: t.species, height: t.height, forest: f.name },
                join: [t.forestId, f.id],
                where: { [t.height]: { $gt: 30 } },
                orderBy: { [t.height]: 'asc' },
                limit: 3,
            };
        });

        expect(results.length).toBe(3);
        // All should have height > 30
        expect(results.every((r: any) => r.height > 30)).toBe(true);
        // Should be ascending
        for (let i = 1; i < results.length; i++) {
            expect((results[i] as any).height).toBeGreaterThanOrEqual((results[i - 1] as any).height);
        }
    });

    // ---- ColumnNode toString verification ----

    it('should generate correct alias.column strings via toString()', () => {
        // Access a proxy to verify the ColumnNode toString behavior
        const { ColumnNode } = require('../src/proxy-query');
        const node = new ColumnNode('users', 'name', 't1');
        expect(node.toString()).toBe('t1.name');
        expect(`${node}`).toBe('t1.name');
    });
});
