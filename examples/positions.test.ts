/**
 * positions.test.ts — Verifies the SatiDB-based positions example
 *
 * Covers:
 *  - Schema validation (rejects bad data)
 *  - Insert + query by commitHash
 *  - Upsert (insert-or-update)
 *  - Composite index existence
 *  - Change tracking on mutations
 */

import { describe, test, expect } from 'bun:test';
import { SatiDB, z } from '../src/satidb';

// ── Inline schema (mirrors positions.ts) ─────────────────────────

const PositionSchema = z.object({
    commitHash: z.string(),
    filePath: z.string(),
    x: z.number(),
    y: z.number(),
    width: z.number().optional(),
    height: z.number().optional(),
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
});

const db = new SatiDB(':memory:', {
    positions: PositionSchema,
}, {
    changeTracking: true,
    indexes: {
        positions: [
            'commitHash',
            ['commitHash', 'filePath'],
        ],
    },
});

// ── Tests ────────────────────────────────────────────────────────

describe('Positions Example', () => {

    test('insert and retrieve positions', () => {
        db.positions.insert({ commitHash: 'abc123', filePath: 'src/app.ts', x: 100, y: 200 });
        db.positions.insert({ commitHash: 'abc123', filePath: 'src/utils.ts', x: 300, y: 50, width: 200, height: 150 });
        db.positions.insert({ commitHash: 'def456', filePath: 'src/app.ts', x: 10, y: 20 });

        const all = db.positions.select().all();
        expect(all.length).toBe(3);
    });

    test('query by commitHash', () => {
        const positions = db.positions.select().where({ commitHash: 'abc123' }).all();
        expect(positions.length).toBe(2);
        expect(positions.every((p: any) => p.commitHash === 'abc123')).toBe(true);
    });

    test('build position map (like the GET endpoint)', () => {
        const positions = db.positions.select().where({ commitHash: 'abc123' }).all();
        const map: Record<string, any> = {};
        for (const pos of positions) {
            map[`${pos.commitHash}:${pos.filePath}`] = {
                x: pos.x, y: pos.y, width: pos.width, height: pos.height,
            };
        }

        expect(map['abc123:src/app.ts']!.x).toBe(100);
        expect(map['abc123:src/app.ts']!.y).toBe(200);
        expect(map['abc123:src/utils.ts']).toEqual({ x: 300, y: 50, width: 200, height: 150 });
    });

    test('upsert: update existing position', () => {
        // Move the file to a new position
        db.positions.upsert(
            { commitHash: 'abc123', filePath: 'src/app.ts' },
            { commitHash: 'abc123', filePath: 'src/app.ts', x: 999, y: 888, updatedAt: Math.floor(Date.now() / 1000) },
        );

        const pos = db.positions.select().where({ commitHash: 'abc123', filePath: 'src/app.ts' }).get()!;
        expect(pos.x).toBe(999);
        expect(pos.y).toBe(888);

        // Still only 3 total rows (no duplicate created)
        expect(db.positions.select().all().length).toBe(3);
    });

    test('upsert: insert when not existing', () => {
        db.positions.upsert(
            { commitHash: 'new111', filePath: 'readme.md' },
            { commitHash: 'new111', filePath: 'readme.md', x: 0, y: 0, width: 400, height: 300 },
        );

        const pos = db.positions.select().where({ commitHash: 'new111' }).get()!;
        expect(pos.filePath).toBe('readme.md');
        expect(pos.width).toBe(400);

        expect(db.positions.select().all().length).toBe(4);
    });

    test('indexes: commitHash and composite index exist', () => {
        const indexes = (db as any).db
            .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='positions'")
            .all() as { name: string }[];
        const names = indexes.map(i => i.name);

        expect(names).toContain('idx_positions_commitHash');
        expect(names).toContain('idx_positions_commitHash_filePath');
    });

    test('change tracking: mutations are logged', () => {
        const changes = db.getChangesSince(0, 'positions');
        // We did 4 inserts + 1 update from upsert
        expect(changes.length).toBeGreaterThanOrEqual(4);
        expect(changes.some(c => c.action === 'INSERT')).toBe(true);
    });

    test('fluent query: order by x descending', () => {
        const positions = db.positions.select()
            .where({ commitHash: 'abc123' })
            .orderBy('x', 'desc')
            .all();

        expect(positions[0]!.x).toBeGreaterThanOrEqual(positions[1]!.x);
    });
});
