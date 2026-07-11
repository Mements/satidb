/**
 * setup.ts — Shared schemas and factory for integration tests
 *
 * Each test file creates its own in-memory DB via createTestDb().
 * This avoids cross-file state leakage when Bun runs files in parallel.
 */

import { Database, z } from "../src/index";

export const ForestSchema = z.object({
  name: z.string(),
  address: z.string(),
});

export const TreeSchema = z.object({
  name: z.string(),
  planted: z.string(),
  alive: z.boolean().default(true),
  forest_id: z.number().optional(),
});

export const AuthorSchema = z.object({
  name: z.string(),
  country: z.string(),
});

export const BookSchema = z.object({
  title: z.string(),
  year: z.number(),
  author_id: z.number().optional(),
});

/**
 * Create a fresh in-memory test database with forests + trees schemas.
 * Each test file should call this once.
 */
export function createTestDb() {
  return new Database(
    ":memory:",
    {
      forests: ForestSchema,
      trees: TreeSchema,
    },
    {
      relations: { trees: { forest_id: "forests" } },
      indexes: { trees: ["forest_id", "planted"] },
    },
  );
}

/** Seed standard forests + trees data into a test DB. */
export function seedData(db: ReturnType<typeof createTestDb>) {
  const amazon = db.forests.insert({ name: "Amazon", address: "Brazil" });
  const sherwood = db.forests.insert({
    name: "Sherwood",
    address: "Nottingham",
  });

  db.trees.insert({
    name: "Mahogany",
    planted: "2020-01-15",
    forest_id: amazon.id,
  });
  db.trees.insert({
    name: "Rubber Tree",
    planted: "2019-06-20",
    forest_id: amazon.id,
  });
  db.trees.insert({
    name: "Brazil Nut",
    planted: "2021-03-10",
    forest_id: amazon.id,
  });
  db.trees.insert({
    name: "Major Oak",
    planted: "1500-01-01",
    alive: true,
    forest_id: sherwood.id,
  });
  db.trees.insert({
    name: "Robin Hood Oak",
    planted: "1600-01-01",
    alive: false,
    forest_id: sherwood.id,
  });
  db.trees.insert({
    name: "Merry Men Elm",
    planted: "1650-01-01",
    alive: false,
    forest_id: sherwood.id,
  });
  db.trees.insert({
    name: "Friar Tuck Yew",
    planted: "1700-01-01",
    alive: false,
    forest_id: sherwood.id,
  });

  return { amazon, sherwood };
}

export { Database, z };
