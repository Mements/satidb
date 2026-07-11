/**
 * Unit tests for src/ast.ts
 *
 * Validates the AST node compiler, proxy factories, and operator helpers
 * in isolation — no database involved.
 */

import { test, expect } from "bun:test";
import {
  compileAST,
  wrapNode,
  createColumnProxy,
  createFunctionProxy,
  op,
  type ASTNode,
} from "../src/ast";

// ── wrapNode ────────────────────────────────────────────────

test("wrapNode wraps primitives into literal nodes", () => {
  const n = wrapNode(42);
  expect(n.type).toBe("literal");
  expect((n as any).value).toBe(42);
});

test("wrapNode passes through existing AST nodes", () => {
  const col: ASTNode = { type: "column", name: "id" };
  expect(wrapNode(col)).toBe(col); // same reference
});

test("wrapNode wraps null as literal", () => {
  const n = wrapNode(null);
  expect(n.type).toBe("literal");
});

// ── compileAST: columns ─────────────────────────────────────

test("compileAST: column node produces quoted name, no params", () => {
  const { sql, params } = compileAST({ type: "column", name: "age" });
  expect(sql).toBe('"age"');
  expect(params).toEqual([]);
});

// ── compileAST: literals ────────────────────────────────────

test("compileAST: literal node produces ? placeholder", () => {
  const { sql, params } = compileAST({ type: "literal", value: "hello" });
  expect(sql).toBe("?");
  expect(params).toEqual(["hello"]);
});

test("compileAST: Date literal converts to ISO string", () => {
  const d = new Date("2025-01-01T00:00:00Z");
  const { params } = compileAST({ type: "literal", value: d });
  expect(params[0]).toBe(d.toISOString());
});

test("compileAST: boolean literal converts to 0/1", () => {
  expect(compileAST({ type: "literal", value: true }).params[0]).toBe(1);
  expect(compileAST({ type: "literal", value: false }).params[0]).toBe(0);
});

// ── compileAST: operators ───────────────────────────────────

test("compileAST: operator node produces (left OP right)", () => {
  const node: ASTNode = {
    type: "operator",
    op: "=",
    left: { type: "column", name: "name" },
    right: { type: "literal", value: "Alice" },
  };
  const { sql, params } = compileAST(node);
  expect(sql).toBe('("name" = ?)');
  expect(params).toEqual(["Alice"]);
});

test("compileAST: nested operators compose correctly", () => {
  const node = op.and(
    op.eq({ type: "column", name: "a" }, 1),
    op.gt({ type: "column", name: "b" }, 2),
  );
  const { sql, params } = compileAST(node);
  expect(sql).toBe('(("a" = ?) AND ("b" > ?))');
  expect(params).toEqual([1, 2]);
});

// ── compileAST: functions ───────────────────────────────────

test("compileAST: function node produces FUNC(args)", () => {
  const node: ASTNode = {
    type: "function",
    name: "LOWER",
    args: [{ type: "column", name: "name" }],
  };
  const { sql, params } = compileAST(node);
  expect(sql).toBe('LOWER("name")');
  expect(params).toEqual([]);
});

test("compileAST: function with literal arg", () => {
  const node: ASTNode = {
    type: "function",
    name: "SUBSTR",
    args: [
      { type: "column", name: "name" },
      { type: "literal", value: 1 },
      { type: "literal", value: 3 },
    ],
  };
  const { sql, params } = compileAST(node);
  expect(sql).toBe('SUBSTR("name", ?, ?)');
  expect(params).toEqual([1, 3]);
});

// ── createColumnProxy ───────────────────────────────────────

test("column proxy returns column AST nodes", () => {
  const c = createColumnProxy<{ id: number; name: string }>();
  const node = c.name;
  expect(node.type).toBe("column");
  expect((node as any).name).toBe("name");
});

// ── createFunctionProxy ─────────────────────────────────────

test("function proxy returns function AST nodes with UPPER name", () => {
  const f = createFunctionProxy();
  const node = f.lower!({ type: "column", name: "x" });
  expect(node.type).toBe("function");
  expect((node as any).name).toBe("LOWER");
  expect((node as any).args.length).toBe(1);
});

test("function proxy wraps raw values via wrapNode", () => {
  const f = createFunctionProxy();
  const node = f.concat!({ type: "column", name: "a" }, " - ", {
    type: "column",
    name: "b",
  });
  expect((node as any).args.length).toBe(3);
  expect((node as any).args[1].type).toBe("literal"); // raw string wrapped
});

// ── op helpers ──────────────────────────────────────────────

test("op.eq, op.ne, op.gt, op.gte, op.lt, op.lte produce correct operators", () => {
  const pairs: [keyof typeof op, string][] = [
    ["eq", "="],
    ["ne", "!="],
    ["gt", ">"],
    ["gte", ">="],
    ["lt", "<"],
    ["lte", "<="],
  ];
  for (const [fn, expected] of pairs) {
    const node = (op as any)[fn]({ type: "column", name: "x" }, 1) as ASTNode;
    expect(node.type).toBe("operator");
    expect((node as any).op).toBe(expected);
  }
});

test("op.and / op.or compose two nodes", () => {
  const a = op.eq({ type: "column", name: "x" }, 1);
  const b = op.eq({ type: "column", name: "y" }, 2);

  const andNode = op.and(a, b);
  expect((andNode as any).op).toBe("AND");

  const orNode = op.or(a, b);
  expect((orNode as any).op).toBe("OR");
});

test("op.like produces LIKE operator", () => {
  const node = op.like({ type: "column", name: "name" }, "%alice%");
  const { sql, params } = compileAST(node);
  expect(sql).toBe('("name" LIKE ?)');
  expect(params).toEqual(["%alice%"]);
});

test("op.isNull / op.isNotNull", () => {
  const isNullNode = op.isNull({ type: "column", name: "email" });
  expect(compileAST(isNullNode).sql).toBe('("email" IS ?)');

  const isNotNullNode = op.isNotNull({ type: "column", name: "email" });
  expect(compileAST(isNotNullNode).sql).toBe('("email" IS NOT ?)');
});

// ── Full round-trip: proxy + compile ────────────────────────

test("end-to-end: proxy → AST → SQL", () => {
  const c = createColumnProxy<{ name: string; age: number }>();
  const f = createFunctionProxy();

  const ast = op.and(op.eq(f.lower!(c.name), "alice"), op.gte(c.age, 18));

  const { sql, params } = compileAST(ast);
  expect(sql).toBe('((LOWER("name") = ?) AND ("age" >= ?))');
  expect(params).toEqual(["alice", 18]);
});
