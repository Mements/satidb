/**
 * relations.test.ts — Relationships, navigation, joins, eager loading
 *
 * Tests FK inserts, lazy navigation, fluent joins, proxy queries,
 * entity references in WHERE, and .with() eager loading.
 */

import { describe, test, expect } from "bun:test";
import {
  createTestDb,
  seedData,
  Database,
  AuthorSchema,
  BookSchema,
} from "./setup";

const db = createTestDb();
seedData(db);

// ── FK inserts ──────────────────────────────────────────────

describe("Explicit FK inserts", () => {
  test("insert with forest_id", () => {
    const amazon = db.forests.select().where({ name: "Amazon" }).get()!;
    const tree = db.trees.insert({
      name: "FK Test Tree",
      planted: "2024-01-01",
      forest_id: amazon.id,
    });
    expect(tree.forest_id).toBe(amazon.id);
  });
});

// ── Lazy navigation ─────────────────────────────────────────

describe("Lazy navigation", () => {
  test("belongs-to: tree.forest()", () => {
    const tree = db.trees.select().where({ name: "Mahogany" }).get()!;
    const forest = (tree as any).forest();
    expect(forest).not.toBeNull();
    expect(forest.name).toBe("Amazon");
  });

  test("has-many: forest.trees()", () => {
    const sherwood = db.forests.select().where({ name: "Sherwood" }).get()!;
    const trees = (sherwood as any).trees();
    expect(trees.length).toBeGreaterThanOrEqual(4);
    const names = trees.map((t: any) => t.name);
    expect(names).toContain("Major Oak");
  });
});

// ── Fluent join ─────────────────────────────────────────────

describe("Fluent join", () => {
  test("join trees + forests", () => {
    const rows = db.trees
      .select("name", "planted")
      .join(db.forests, ["name", "address"])
      .orderBy("planted", "asc")
      .all();
    expect(rows.length).toBeGreaterThanOrEqual(4);
  });

  test("join with where filters", () => {
    const rows = db.trees
      .select("name", "planted")
      .join(db.forests, ["name", "address"])
      .where({ alive: true })
      .all();
    expect(rows.length).toBeGreaterThanOrEqual(4);
  });
});

// ── Proxy query ─────────────────────────────────────────────

describe("Proxy query", () => {
  test("basic join + where + orderBy", () => {
    const rows = db.query((c: any) => {
      const { forests: f, trees: t } = c;
      return {
        select: { tree: t.name, forest: f.name },
        join: [[t.forest_id, f.id]],
        where: { [f.name]: "Amazon" },
        orderBy: { [t.planted]: "asc" },
      };
    });
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect((rows[0] as any).forest).toBe("Amazon");
  });

  test("proxy query returns all matching rows", () => {
    const rows = db.query((c: any) => {
      const { forests: f, trees: t } = c;
      return {
        select: { tree: t.name, forest: f.name },
        join: [[t.forest_id, f.id]],
      };
    });
    expect(rows.length).toBeGreaterThanOrEqual(5);
  });
});

// ── Config-based relations (authors/books) ──────────────────

describe("Config-based relations — authors/books", () => {
  const cdb = new Database(
    ":memory:",
    {
      authors: AuthorSchema,
      books: BookSchema,
    },
    {
      relations: { books: { author_id: "authors" } },
    },
  );

  const tolstoy = cdb.authors.insert({
    name: "Leo Tolstoy",
    country: "Russia",
  });
  const kafka = cdb.authors.insert({
    name: "Franz Kafka",
    country: "Czech Republic",
  });
  cdb.books.insert({
    title: "War and Peace",
    year: 1869,
    author_id: tolstoy.id,
  });
  cdb.books.insert({
    title: "Anna Karenina",
    year: 1878,
    author_id: tolstoy.id,
  });
  cdb.books.insert({ title: "The Trial", year: 1925, author_id: kafka.id });

  test("FK column is author_id", () => {
    const books = cdb.books.select().all();
    expect(books.length).toBe(3);
    expect(books[0]!.author_id).toBe(tolstoy.id);
  });

  test("select().where() with FK", () => {
    const books = cdb.books.select().where({ author_id: tolstoy.id }).all();
    expect(books.length).toBe(2);
    expect(books.map((b) => b.title).sort()).toEqual([
      "Anna Karenina",
      "War and Peace",
    ]);
  });

  test("lazy navigation: book.author()", () => {
    const book = cdb.books.select().where({ title: "War and Peace" }).get()!;
    const author = (book as any).author();
    expect(author.name).toBe("Leo Tolstoy");
  });

  test("lazy navigation: author.books()", () => {
    const author = cdb.authors.select().where({ name: "Leo Tolstoy" }).get()!;
    const books = (author as any).books();
    expect(books.length).toBe(2);
  });

  test("fluent join", () => {
    const rows = cdb.books
      .select("title", "year")
      .join(cdb.authors, ["name"])
      .orderBy("year", "asc")
      .all();
    expect(rows.length).toBe(3);
    expect((rows[0] as any).authors_name).toBe("Leo Tolstoy");
  });

  test("proxy query", () => {
    const rows = cdb.query((c: any) => {
      const { authors: a, books: b } = c;
      return {
        select: { author: a.name, book: b.title },
        join: [[b.author_id, a.id]],
        where: { [a.country]: "Russia" },
        orderBy: { [b.year]: "asc" },
      };
    });
    expect(rows.length).toBe(2);
    expect((rows[0] as any).author).toBe("Leo Tolstoy");
  });

  test("where with entity reference", () => {
    const books = cdb.books
      .select()
      .where({ author: tolstoy } as any)
      .all();
    expect(books.length).toBe(2);
  });

  test("join + where with entity reference", () => {
    const rows = cdb.books
      .select("title", "year")
      .join(cdb.authors, ["name", "country"])
      .where({ author: tolstoy } as any)
      .orderBy("year", "asc")
      .all();
    expect(rows.length).toBe(2);
    expect((rows[0] as any).title).toBe("War and Peace");
  });

  test("join + where with dot-qualified column", () => {
    const rows = cdb.books
      .select("title")
      .join(cdb.authors, ["name", "country"])
      .where({ "authors.country": "Czech Republic" } as any)
      .all();
    expect(rows.length).toBe(1);
    expect((rows[0] as any).title).toBe("The Trial");
  });

  test(".with() eager loading — single author", () => {
    const t = cdb.authors
      .select()
      .where({ name: "Leo Tolstoy" })
      .with("books")
      .get()! as any;
    expect(t.books.length).toBe(2);
    expect(t.books.map((b: any) => b.title).sort()).toEqual([
      "Anna Karenina",
      "War and Peace",
    ]);
  });

  test(".with() eager loading — all authors", () => {
    const authors = cdb.authors.select().with("books").all() as any[];
    const t = authors.find((a: any) => a.name === "Leo Tolstoy")!;
    const k = authors.find((a: any) => a.name === "Franz Kafka")!;
    expect(t.books.length).toBe(2);
    expect(k.books.length).toBe(1);
  });

  test(".with() — children are augmented entities", () => {
    const author = cdb.authors
      .select()
      .where({ name: "Franz Kafka" })
      .with("books")
      .get()! as any;
    expect(typeof author.books[0].update).toBe("function");
    expect(typeof author.books[0].delete).toBe("function");
  });

  test(".with() — entity with no children gets empty array", () => {
    const newAuthor = cdb.authors.insert({
      name: "Unknown Author",
      country: "N/A",
    });
    const loaded = cdb.authors
      .select()
      .where({ id: newAuthor.id })
      .with("books")
      .get()! as any;
    expect(loaded.books.length).toBe(0);
    newAuthor.delete();
  });
});
