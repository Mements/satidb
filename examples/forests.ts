/**
 * forests.ts — sqlite-zod-orm example: Forests & Trees
 *
 * A side-by-side comparison showing how sqlite-zod-orm handles
 * the classic parent-child pattern with:
 *  - Zod schemas with runtime validation
 *  - z.lazy() relationships (auto foreign keys, .push(), navigation)
 *  - Fluent select() builder
 *  - SQL-like db.query(c => {...}) proxy callback for JOINs
 *  - Computed fields via getters (no special DSL)
 *  - Indexes declared in config
 *
 *    bun test examples/forests.test.ts
 */

import { SatiDB, z } from '../src/satidb';

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
    const db = new SatiDB(dbPath, {
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
