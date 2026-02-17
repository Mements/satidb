/**
 * positions.ts — SatiDB replacement for raw SQLite positions API
 *
 * Before:  ~100 lines of manual CREATE TABLE, CREATE INDEX, raw SQL queries
 * After:   Schema + 2 endpoints, zero SQL
 */

import { SatiDB, z } from '../src/satidb';
import path from 'path';

// ── Schema ───────────────────────────────────────────────────────

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

// ── Database (lazy singleton) ────────────────────────────────────

let _db: ReturnType<typeof createDb> | null = null;

function createDb() {
    const dbPath = path.join(process.cwd(), 'db', 'positions.db');
    return new SatiDB(dbPath, {
        positions: PositionSchema,
    }, {
        changeTracking: true,
        indexes: {
            positions: [
                'commitHash',                    // fast lookup by commit
                ['commitHash', 'filePath'],      // composite for upsert
            ],
        },
    });
}

function getDb() {
    if (!_db) _db = createDb();
    return _db;
}

// ── GET /api/positions?commit=abc123 ─────────────────────────────

export async function GET(req: Request) {
    try {
        const url = new URL(req.url);
        const commitHash = url.searchParams.get('commit');
        const db = getDb();

        const positions = commitHash
            ? db.positions.select().where({ commitHash }).all()
            : db.positions.select().all();

        // Convert to the map format the frontend expects
        const positionMap: Record<string, { x: number; y: number; width?: number; height?: number }> = {};
        for (const pos of positions) {
            positionMap[`${pos.commitHash}:${pos.filePath}`] = {
                x: pos.x,
                y: pos.y,
                width: pos.width,
                height: pos.height,
            };
        }

        return Response.json(positionMap);
    } catch (error: any) {
        return new Response(`Error: ${error.message}`, { status: 500 });
    }
}

// ── POST /api/positions ──────────────────────────────────────────

export async function POST(req: Request) {
    try {
        const body = await req.json() as {
            commitHash?: string; filePath?: string;
            x?: number; y?: number; width?: number; height?: number;
        };
        const { commitHash, filePath, x, y, width, height } = body;

        if (!commitHash || !filePath || x === undefined || y === undefined) {
            return new Response('commitHash, filePath, x, and y are required', { status: 400 });
        }

        const db = getDb();

        // Upsert: insert if new, update if exists (matched by commitHash + filePath)
        db.positions.upsert(
            { commitHash, filePath },                       // match conditions
            {
                commitHash, filePath, x, y, width, height,    // data to set
                updatedAt: Math.floor(Date.now() / 1000)
            },
        );

        return Response.json({ success: true });
    } catch (error: any) {
        return new Response(`Error: ${error.message}`, { status: 500 });
    }
}
