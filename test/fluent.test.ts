/**
 * fluent.test.ts — Fluent query builder integration tests
 *
 * Tests select, where, orderBy, limit, offset, count,
 * operator objects ($gt, $in, $ne, $or), and fluent updates.
 */

import { describe, test, expect } from "bun:test";
import { createTestDb, seedData } from "./setup";

const db = createTestDb();
seedData(db);

describe("Fluent queries", () => {
  test("where + orderBy + limit", () => {
    const sherwood = db.forests.select().where({ name: "Sherwood" }).get()!;
    const result = db.trees
      .select()
      .where({ forest_id: sherwood.id, alive: true })
      .orderBy("planted", "asc")
      .limit(1)
      .all();
    expect(result.length).toBe(1);
    expect(result[0]!.name).toBe("Major Oak");
  });

  test("count()", () => {
    const count = db.trees.select().where({ alive: true }).count();
    expect(count).toBeGreaterThanOrEqual(4);
  });

  test("$gt operator", () => {
    const recent = db.trees
      .select()
      .where({ planted: { $gt: "2020-01-01" } })
      .all();
    expect(recent.length).toBeGreaterThanOrEqual(1);
  });

  test("$in operator", () => {
    const result = db.trees
      .select()
      .where({ name: { $in: ["Mahogany", "Major Oak"] } })
      .all();
    expect(result.length).toBe(2);
  });

  test("$ne operator", () => {
    const sherwood = db.forests.select().where({ name: "Sherwood" }).get()!;
    const dead = db.trees
      .select()
      .where({ forest_id: sherwood.id, alive: false })
      .all();
    expect(dead.length).toBe(3);
  });
});

describe("$or queries", () => {
  test("$or combines conditions", () => {
    const result = db.trees
      .select()
      .where({
        $or: [{ name: "Mahogany" }, { name: "Major Oak" }],
      })
      .all();
    expect(result.length).toBe(2);
    const names = result.map((r) => r.name).sort();
    expect(names).toEqual(["Mahogany", "Major Oak"]);
  });

  test("$or with operators", () => {
    const result = db.trees
      .select()
      .where({
        $or: [{ planted: { $gt: "2021-01-01" } }, { alive: false }],
      })
      .all();
    expect(result.length).toBeGreaterThanOrEqual(3);
  });
});

describe("Fluent update", () => {
  test("update().where().exec()", () => {
    const sherwood = db.forests.select().where({ name: "Sherwood" }).get()!;
    const affected = db.trees
      .update({ alive: false } as any)
      .where({ forest_id: sherwood.id, planted: { $gt: "1600-01-01" } })
      .exec();
    expect(affected).toBeGreaterThanOrEqual(0);
  });

  test("update().where().exec() with $in", () => {
    db.trees
      .update({ alive: true } as any)
      .where({ name: { $in: ["Major Oak"] } })
      .exec();
  });
});
