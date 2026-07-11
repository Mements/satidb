/**
 * crud.test.ts — Basic CRUD operations
 *
 * Tests insert, select, get, update, delete for simple entities.
 */

import { describe, test, expect } from "bun:test";
import { createTestDb, seedData } from "./setup";

const db = createTestDb();
seedData(db);

describe("CRUD", () => {
  test("insert returns augmented entity", () => {
    const forest = db.forests.insert({ name: "TestCrud", address: "X" });
    expect(forest.id).toBeDefined();
    expect(forest.name).toBe("TestCrud");
  });

  test("select().all() returns array", () => {
    const all = db.forests.select().all();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  test("select().where().get() returns single row", () => {
    const forest = db.forests.select().where({ name: "Amazon" }).get()!;
    expect(forest.name).toBe("Amazon");
    expect(forest.address).toBe("Brazil");
  });

  test("update() modifies row", () => {
    const forest = db.forests.select().where({ name: "Amazon" }).get()!;
    db.forests.update(forest.id, { address: "South America" });
    const updated = db.forests.select().where({ name: "Amazon" }).get()!;
    expect(updated.address).toBe("South America");
  });

  test("delete() removes row", () => {
    const extra = db.forests.insert({ name: "TempForest", address: "Nowhere" });
    const countBefore = db.forests.select().count();
    db.forests.delete(extra.id);
    expect(db.forests.select().count()).toBe(countBefore - 1);
  });
});
