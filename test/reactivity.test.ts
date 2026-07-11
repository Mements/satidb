/**
 * reactivity.test.ts — Change listeners (.on()) and reactive options
 *
 * Tests the trigger-based change tracking system:
 * insert/update/delete events, unsubscribe, and reactive:false mode.
 */

import { describe, test, expect } from "bun:test";
import {
  createTestDb,
  seedData,
  Database,
  ForestSchema,
  TreeSchema,
} from "./setup";

const db = createTestDb();
seedData(db);

describe("Change listeners (on)", () => {
  test('on("insert") fires for new rows', async () => {
    const received: string[] = [];
    const unsub = db.forests.on("insert", (forest) => {
      received.push(forest.name);
    });

    db.forests.insert({ name: "OnInsert1", address: "A" });
    db.forests.insert({ name: "OnInsert2", address: "B" });

    await new Promise((r) => setTimeout(r, 200));

    expect(received).toContain("OnInsert1");
    expect(received).toContain("OnInsert2");
    expect(received.indexOf("OnInsert1")).toBeLessThan(
      received.indexOf("OnInsert2"),
    );

    unsub();
  });

  test('on("update") fires for updated rows', async () => {
    const forest = db.forests.insert({ name: "OnUpdate1", address: "Before" });

    const received: string[] = [];
    const unsub = db.forests.on("update", (row) => {
      received.push(row.address);
    });

    db.forests.update(forest.id, { address: "After" });
    await new Promise((r) => setTimeout(r, 200));

    expect(received).toContain("After");
    unsub();
  });

  test('on("delete") fires with { id } for deleted rows', async () => {
    const forest = db.forests.insert({ name: "OnDelete1", address: "X" });

    const received: number[] = [];
    const unsub = db.forests.on("delete", (row) => {
      received.push(row.id);
    });

    db.forests.delete(forest.id);
    await new Promise((r) => setTimeout(r, 200));

    expect(received).toContain(forest.id);
    unsub();
  });

  test("unsubscribe stops listener", async () => {
    const received: string[] = [];
    const unsub = db.forests.on("insert", (forest) => {
      received.push(forest.name);
    });

    db.forests.insert({ name: "BeforeUnsub", address: "A" });
    await new Promise((r) => setTimeout(r, 200));
    expect(received.length).toBe(1);

    unsub();

    db.forests.insert({ name: "AfterUnsub", address: "B" });
    await new Promise((r) => setTimeout(r, 200));
    expect(received.length).toBe(1);
  });

  test("reactive: false disables triggers and .on() throws", () => {
    const nonReactiveDb = new Database(
      ":memory:",
      {
        forests: ForestSchema,
        trees: TreeSchema,
      },
      {
        relations: { trees: { forest_id: "forests" } },
        reactive: false,
      },
    );

    // CRUD still works
    const f = nonReactiveDb.forests.insert({ name: "Test", address: "X" });
    expect(f.name).toBe("Test");
    expect(nonReactiveDb.forests.select().count()).toBe(1);

    // on() throws
    expect(() => {
      nonReactiveDb.forests.on("insert", () => {});
    }).toThrow(/Change listeners are disabled/);
  });
});
