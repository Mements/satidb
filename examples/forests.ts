/**
 * forests.ts — sqlite-zod-orm example: Forests & Trees
 *
 * Demonstrates:
 *  - Zod schemas with z.lazy() relationships (auto foreign keys)
 *  - Fluent select().where().join() builder
 *  - SQL-like db.query(c => {...}) proxy callback
 *  - Computed fields, defaults, indexes
 *
 *   bun test examples/forests.test.ts
 */

import { Database, z } from '../src/satidb';

// =============================================================================
// SCHEMAS
// =============================================================================

interface Forest {
    name: string;
    address: string;
    trees?: Tree[];
}

interface Tree {
    name: string;
    planted: string;
    alive: boolean;
    forest?: Forest;
}

const ForestSchema: z.ZodType<Forest> = z.object({
    name: z.string(),
    address: z.string(),
    trees: z.lazy(() => z.array(TreeSchema)).optional(),
});

const TreeSchema: z.ZodType<Tree> = z.object({
    name: z.string(),
    planted: z.string(),                               // ISO date string
    alive: z.boolean().default(true),                   // defaults to alive
    forest: z.lazy(() => ForestSchema).optional(),      // belongs-to → auto forestId FK
});

// =============================================================================
// DATABASE
// =============================================================================

export function createForestsDb(dbPath = ':memory:') {
    const db = new Database(dbPath, {
        forests: ForestSchema,
        trees: TreeSchema,
    }, {
        indexes: {
            trees: ['forestId', 'planted'],   // auto-indexed FK + date
        },
    });

    // =========================================================================
    // COMPUTED FIELDS — just functions, no DSL needed
    // =========================================================================

    function displayName(forest: any) {
        return `${forest.name} - ${forest.address}`;
    }

    return { db, displayName };
}
