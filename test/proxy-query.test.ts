/**
 * Unit tests for src/proxy-query.ts
 *
 * Tests the ColumnNode, context proxy creation, and proxy query
 * compilation in isolation.
 */

import { test, expect } from 'bun:test';
import { ColumnNode, createContextProxy, compileProxyQuery } from '../src/query';

// ── ColumnNode ──────────────────────────────────────────────

test('ColumnNode stores table, column, alias', () => {
    const node = new ColumnNode('users', 'name', 't1');
    expect(node.table).toBe('users');
    expect(node.column).toBe('name');
    expect(node.alias).toBe('t1');
    expect(node._type).toBe('COL');
});

test('ColumnNode.toString() returns quoted alias.column for computed keys', () => {
    const node = new ColumnNode('users', 'email', 't2');
    expect(node.toString()).toBe('"t2"."email"');
    expect(`${node}`).toBe('"t2"."email"');
});

// ── createContextProxy ──────────────────────────────────────

test('context proxy returns table proxies with ColumnNode columns', () => {
    const schemas: any = {
        users: { shape: { name: {}, age: {} } },
        posts: { shape: { title: {}, content: {} } },
    };

    const { proxy, aliasMap } = createContextProxy(schemas);
    const u = (proxy as any).users;

    const col: ColumnNode = u.name;
    expect(col).toBeInstanceOf(ColumnNode);
    expect(col.table).toBe('users');
    expect(col.column).toBe('name');

    expect(aliasMap.size).toBeGreaterThan(0);
});

test('context proxy assigns unique aliases to different tables', () => {
    const schemas: any = {
        users: { shape: { name: {} } },
        posts: { shape: { title: {} } },
    };

    const { proxy } = createContextProxy(schemas);
    const uCol: ColumnNode = (proxy as any).users.name;
    const pCol: ColumnNode = (proxy as any).posts.title;

    expect(uCol.alias).not.toBe(pCol.alias);
});

// ── compileProxyQuery ───────────────────────────────────────

test('compileProxyQuery: basic SELECT without JOIN', () => {
    const schemas: any = { users: { shape: { name: {}, age: {} } } };
    const { proxy, aliasMap } = createContextProxy(schemas);
    const u = (proxy as any).users;

    const { sql, params } = compileProxyQuery(
        { select: { name: u.name, age: u.age } },
        aliasMap,
    );
    expect(sql).toContain('SELECT');
    expect(sql).toContain('name');
    expect(sql).toContain('age');
    expect(params).toEqual([]);
});

test('compileProxyQuery: WHERE with literal value', () => {
    const schemas: any = { users: { shape: { name: {}, age: {} } } };
    const { proxy, aliasMap } = createContextProxy(schemas);
    const u = (proxy as any).users;

    const { sql, params } = compileProxyQuery(
        { select: { name: u.name }, where: { [u.name]: 'Alice' } },
        aliasMap,
    );
    expect(sql).toContain('WHERE');
    expect(params).toContain('Alice');
});

test('compileProxyQuery: WHERE with $gt operator', () => {
    const schemas: any = { users: { shape: { name: {}, age: {} } } };
    const { proxy, aliasMap } = createContextProxy(schemas);
    const u = (proxy as any).users;

    const { sql, params } = compileProxyQuery(
        { select: { name: u.name }, where: { [u.age]: { $gt: 18 } } },
        aliasMap,
    );
    expect(sql).toContain('>');
    expect(params).toContain(18);
});

test('compileProxyQuery: LIMIT', () => {
    const schemas: any = { users: { shape: { name: {} } } };
    const { proxy, aliasMap } = createContextProxy(schemas);
    const u = (proxy as any).users;

    const { sql } = compileProxyQuery(
        { select: { name: u.name }, limit: 5 },
        aliasMap,
    );
    expect(sql).toContain('LIMIT 5');
});

test('compileProxyQuery: ORDER BY', () => {
    const schemas: any = { users: { shape: { name: {}, age: {} } } };
    const { proxy, aliasMap } = createContextProxy(schemas);
    const u = (proxy as any).users;

    const { sql } = compileProxyQuery(
        { select: { name: u.name }, orderBy: { [u.age]: 'desc' } },
        aliasMap,
    );
    expect(sql).toContain('ORDER BY');
    expect(sql).toContain('DESC');
});

test('compileProxyQuery: JOIN between two tables', () => {
    const schemas: any = {
        users: { shape: { name: {}, id: {} } },
        posts: { shape: { title: {}, userId: {} } },
    };
    const { proxy, aliasMap } = createContextProxy(schemas);
    const u = (proxy as any).users;
    const p = (proxy as any).posts;

    const { sql } = compileProxyQuery(
        {
            select: { name: u.name, title: p.title },
            join: [p.userId, u.id],
        },
        aliasMap,
    );
    expect(sql).toContain('JOIN');
});

test('compileProxyQuery: explicit FK column in schema', () => {
    const { z } = require('zod');

    const UserSchema = z.object({ name: z.string() });
    const PostSchema = z.object({ title: z.string(), user_id: z.number().optional() });

    const schemas: any = {
        users: UserSchema,
        posts: PostSchema,
    };

    const { proxy, aliasMap } = createContextProxy(schemas);
    const u = (proxy as any).users;
    const p = (proxy as any).posts;

    // p.user_id is a real schema column — no magic resolution
    expect(p.user_id.column).toBe('user_id');

    const { sql } = compileProxyQuery(
        {
            select: { name: u.name, title: p.title },
            join: [p.user_id, u.id],
        },
        aliasMap,
    );
    expect(sql).toContain('JOIN');
    expect(sql).toContain('"user_id"');
});
