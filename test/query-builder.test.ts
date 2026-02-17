/**
 * Unit tests for src/query-builder.ts
 *
 * Tests the IQO compiler and QueryBuilder class independently,
 * using mock executors instead of a real database.
 */

import { test, expect } from 'bun:test';
import { compileIQO, QueryBuilder } from '../src/query-builder';

// ── compileIQO ──────────────────────────────────────────────

test('compileIQO: empty IQO produces SELECT * FROM table', () => {
    const { sql, params } = compileIQO('users', {
        selects: [], wheres: [], whereOrs: [], whereAST: null,
        limit: null, offset: null, orderBy: [], includes: [], raw: false, joins: [],
    });
    expect(sql).toBe('SELECT users.* FROM users');
    expect(params).toEqual([]);
});

test('compileIQO: specific columns', () => {
    const { sql } = compileIQO('users', {
        selects: ['name', 'age'], wheres: [], whereOrs: [], whereAST: null,
        limit: null, offset: null, orderBy: [], includes: [], raw: false, joins: [],
    });
    expect(sql).toBe('SELECT users.name, users.age FROM users');
});

test('compileIQO: WHERE conditions', () => {
    const { sql, params } = compileIQO('users', {
        selects: [], whereAST: null, whereOrs: [],
        wheres: [
            { field: 'name', operator: '=', value: 'Alice' },
            { field: 'age', operator: '>', value: 18 },
        ],
        limit: null, offset: null, orderBy: [], includes: [], raw: false, joins: [],
    });
    expect(sql).toBe('SELECT users.* FROM users WHERE name = ? AND age > ?');
    expect(params).toEqual(['Alice', 18]);
});

test('compileIQO: IN operator', () => {
    const { sql, params } = compileIQO('users', {
        selects: [], whereAST: null, whereOrs: [],
        wheres: [{ field: 'role', operator: 'IN', value: ['admin', 'mod'] }],
        limit: null, offset: null, orderBy: [], includes: [], raw: false, joins: [],
    });
    expect(sql).toContain('role IN (?, ?)');
    expect(params).toEqual(['admin', 'mod']);
});

test('compileIQO: empty IN produces 1 = 0', () => {
    const { sql } = compileIQO('users', {
        selects: [], whereAST: null, whereOrs: [],
        wheres: [{ field: 'role', operator: 'IN', value: [] }],
        limit: null, offset: null, orderBy: [], includes: [], raw: false, joins: [],
    });
    expect(sql).toContain('1 = 0');
});

test('compileIQO: ORDER BY, LIMIT, OFFSET', () => {
    const { sql } = compileIQO('users', {
        selects: [], wheres: [], whereOrs: [], whereAST: null,
        limit: 10, offset: 20,
        orderBy: [{ field: 'name', direction: 'asc' }],
        includes: [], raw: false, joins: [],
    });
    expect(sql).toBe('SELECT users.* FROM users ORDER BY name ASC LIMIT 10 OFFSET 20');
});

test('compileIQO: AST-based WHERE takes precedence over object wheres', () => {
    const { sql, params } = compileIQO('users', {
        selects: [],
        wheres: [{ field: 'name', operator: '=', value: 'IGNORED' }],
        whereAST: {
            type: 'operator', op: '=',
            left: { type: 'column', name: 'age' },
            right: { type: 'literal', value: 30 },
        },
        limit: null, offset: null, orderBy: [], includes: [], raw: false, joins: [], whereOrs: [],
    });
    expect(sql).toContain('("age" = ?)');
    expect(sql).not.toContain('IGNORED');
    expect(params).toEqual([30]);
});

test('compileIQO: Date values get ISO-stringified', () => {
    const d = new Date('2025-06-15T00:00:00Z');
    const { params } = compileIQO('events', {
        selects: [], whereAST: null, whereOrs: [],
        wheres: [{ field: 'createdAt', operator: '>', value: d }],
        limit: null, offset: null, orderBy: [], includes: [], raw: false, joins: [],
    });
    expect(params[0]).toBe(d.toISOString());
});

// ── QueryBuilder (with mock executors) ──────────────────────

function createMockBuilder() {
    const calls: { sql: string; params: any[]; raw: boolean }[] = [];
    const mockData = [
        { id: 1, name: 'Alice', age: 30 },
        { id: 2, name: 'Bob', age: 25 },
    ];

    const executor = (sql: string, params: any[], raw: boolean) => {
        calls.push({ sql, params, raw });
        return mockData;
    };
    const singleExecutor = (sql: string, params: any[], raw: boolean) => {
        calls.push({ sql, params, raw });
        return mockData[0];
    };

    const qb = new QueryBuilder<{ id: number; name: string; age: number }>(
        'users', executor, singleExecutor,
    );

    return { qb, calls };
}

test('QueryBuilder: .all() calls executor', () => {
    const { qb, calls } = createMockBuilder();
    const result = qb.all();
    expect(calls.length).toBe(1);
    expect(calls[0].sql).toContain('SELECT');
    expect(result.length).toBe(2);
});

test('QueryBuilder: .get() sets limit 1 and calls singleExecutor', () => {
    const { qb, calls } = createMockBuilder();
    qb.get();
    expect(calls.length).toBe(1);
    expect(calls[0].sql).toContain('LIMIT 1');
});

test('QueryBuilder: chaining builds correct SQL', () => {
    const { qb, calls } = createMockBuilder();
    qb.select('name', 'age')
        .where({ name: 'Alice' })
        .orderBy('age', 'desc')
        .limit(5)
        .offset(10)
        .all();

    const sql = calls[0].sql;
    expect(sql).toContain('users.name, users.age');
    expect(sql).toContain('WHERE');
    expect(sql).toContain('ORDER BY age DESC');
    expect(sql).toContain('LIMIT 5');
    expect(sql).toContain('OFFSET 10');
});

test('QueryBuilder: .raw() passes raw=true to executor', () => {
    const { qb, calls } = createMockBuilder();
    qb.raw().all();
    expect(calls[0].raw).toBe(true);
});

test('QueryBuilder: callback where generates AST-based SQL', () => {
    const { qb, calls } = createMockBuilder();
    qb.where((c, f, op) => op.eq(c.name, 'Alice')).all();

    const sql = calls[0].sql;
    expect(sql).toContain('("name" = ?)');
    expect(calls[0].params).toEqual(['Alice']);
});

test('QueryBuilder: multiple .where() calls compose with AND', () => {
    const { qb, calls } = createMockBuilder();
    qb.where({ age: 30 }).where({ name: 'Alice' }).all();

    const sql = calls[0].sql;
    expect(sql).toContain('age = ?');
    expect(sql).toContain('AND');
    expect(sql).toContain('name = ?');
});

test('QueryBuilder: operator objects $gt, $in, $ne', () => {
    const { qb, calls } = createMockBuilder();
    qb.where({ age: { $gt: 18 }, name: { $ne: 'admin' } }).all();

    const sql = calls[0].sql;
    expect(sql).toContain('age > ?');
    expect(sql).toContain('name != ?');
    expect(calls[0].params).toContain(18);
    expect(calls[0].params).toContain('admin');
});

test('QueryBuilder: invalid operator throws', () => {
    const { qb } = createMockBuilder();
    expect(() => qb.where({ age: { $invalid: 5 } } as any).all()).toThrow();
});

test('QueryBuilder: thenable resolves to .all()', async () => {
    const { qb } = createMockBuilder();
    const result = await qb;
    expect(result.length).toBe(2);
});

// ── Subscribe ───────────────────────────────────────────────

test('QueryBuilder: subscribe fires callback immediately and on change', async () => {
    let callCount = 0;
    let counter = 0;

    const executor = (sql: string, params: any[], raw: boolean) => {
        // Fingerprint query returns changing count on 2nd call
        if (sql.includes('_cnt')) {
            counter++;
            return [{ _cnt: counter, _max: counter }];
        }
        return [{ id: 1, name: 'Alice', age: 30 }];
    };
    const singleExecutor = () => null;

    const qb = new QueryBuilder<{ id: number; name: string; age: number }>(
        'users', executor, singleExecutor,
    );

    const unsub = qb.subscribe(() => { callCount++; }, { interval: 30 });

    // Immediate call
    expect(callCount).toBe(1);

    // Wait for a couple ticks — fingerprint keeps changing so callback fires each time
    await new Promise(r => setTimeout(r, 100));
    expect(callCount).toBeGreaterThan(1);

    unsub();
    const countAfterUnsub = callCount;
    await new Promise(r => setTimeout(r, 80));
    // No more calls after unsubscribe
    expect(callCount).toBe(countAfterUnsub);
});

test('QueryBuilder: subscribe does not fire when fingerprint unchanged', async () => {
    let callCount = 0;

    const executor = (sql: string) => {
        // Always returns same fingerprint
        if (sql.includes('_cnt')) {
            return [{ _cnt: 5, _max: 10 }];
        }
        return [{ id: 1 }];
    };
    const singleExecutor = () => null;

    const qb = new QueryBuilder<{ id: number }>(
        'users', executor, singleExecutor,
    );

    const unsub = qb.subscribe(() => { callCount++; }, { interval: 30 });

    expect(callCount).toBe(1); // immediate
    await new Promise(r => setTimeout(r, 100));
    // Fingerprint never changed, so no additional calls
    expect(callCount).toBe(1);

    unsub();
});
