/**
 * entity.test.ts — Entity methods and schema validation tests
 *
 * Tests entity .update(), .delete(), upsert, transactions,
 * and Zod schema validation (missing fields, wrong types, defaults).
 */

import { describe, test, expect } from "bun:test";
import { createTestDb, seedData } from "./setup";

const db = createTestDb();
seedData(db);

// ── Upsert & Transactions ───────────────────────────────────

describe("Upsert and transactions", () => {
  test("upsert inserts when not found", () => {
    const amazon = db.forests.select().where({ name: "Amazon" }).get()!;
    db.trees.upsert(
      { name: "Kapok" } as any,
      { name: "Kapok", planted: "2023-01-01", forest_id: amazon.id } as any,
    );
    const kapok = db.trees.select().where({ name: "Kapok" }).get()!;
    expect(kapok).not.toBeNull();
    expect(kapok.planted).toBe("2023-01-01");
  });

  test("upsert updates when found", () => {
    const amazon = db.forests.select().where({ name: "Amazon" }).get()!;
    db.trees.upsert(
      { name: "Kapok" } as any,
      { name: "Kapok", planted: "2024-01-01", forest_id: amazon.id } as any,
    );
    const updated = db.trees.select().where({ name: "Kapok" }).get()!;
    expect(updated.planted).toBe("2024-01-01");
  });

  test("transaction rolls back on error", () => {
    const countBefore = db.forests.select().count();
    expect(() => {
      db.transaction(() => {
        db.forests.insert({ name: "WillFail", address: "Nowhere" });
        throw new Error("kaboom");
      });
    }).toThrow();
    expect(db.forests.select().count()).toBe(countBefore);
  });
});

// ── Entity methods ──────────────────────────────────────────

describe("Entity methods", () => {
  test("entity.update() modifies the row", () => {
    const forest = db.forests.insert({ name: "EntityTest", address: "Old" });
    forest.update({ address: "New" });
    const reloaded = db.forests.select().where({ name: "EntityTest" }).get()!;
    expect(reloaded.address).toBe("New");
  });

  test("entity.delete() removes the row", () => {
    const forest = db.forests.insert({ name: "EntityDel", address: "X" });
    forest.delete();
    const result = db.forests.select().where({ name: "EntityDel" }).get();
    expect(result).toBeNull();
  });

  test("entity properties are writable (not frozen)", () => {
    const tree = db.trees.select().get()!;
    tree.planted = "1990-01-01";
  });
});

// ── Schema validation ───────────────────────────────────────

describe("Schema validation", () => {
  test("insert with missing required field throws", () => {
    expect(() => {
      db.forests.insert({ name: "No Address" } as any);
    }).toThrow();
  });

  test("insert with wrong type throws", () => {
    expect(() => {
      db.trees.insert({ name: 123, planted: "today" } as any);
    }).toThrow();
  });

  test("defaults are applied (alive = true)", () => {
    const amazon = db.forests.select().where({ name: "Amazon" }).get()!;
    const tree = db.trees.insert({
      name: "Test Sapling",
      planted: "2025-01-01",
      forest_id: amazon.id,
    });
    expect(tree.alive).toBe(true);
    tree.delete();
  });
});
