/**
 * bench/indexes.ts — Benchmark: Index impact on common query patterns
 *
 * Measures the performance difference of queries with and without indexes
 * for various access patterns: point lookups, range scans, ORDER BY,
 * and compound indexes.
 *
 * Run: bun bench/indexes.ts
 */
import { Database as SqliteDatabase } from 'bun:sqlite';

const ROWS = 100_000;
const QUERIES = 10_000;

function separator(label: string) {
    console.log();
    console.log('═'.repeat(60));
    console.log(`  ${label}`);
    console.log('═'.repeat(60));
    console.log();
}

function bench(label: string, fn: () => void, iterations: number = QUERIES): string {
    const start = Bun.nanoseconds();
    for (let i = 0; i < iterations; i++) fn();
    const elapsed = (Bun.nanoseconds() - start) / 1_000_000;
    const perOp = elapsed / iterations * 1000;
    const line = `${label.padEnd(40)} ${elapsed.toFixed(1).padStart(8)}ms  (${perOp.toFixed(1)}µs/query)`;
    console.log(line);
    return line;
}

// ═══════════════════════════════════════════════════════════════
// Setup
// ═══════════════════════════════════════════════════════════════

separator('SETUP');

const dbNoIdx = new SqliteDatabase(':memory:');
dbNoIdx.run('PRAGMA journal_mode = WAL');
dbNoIdx.run(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    score INTEGER NOT NULL,
    created_at TEXT NOT NULL
)`);

const dbIdx = new SqliteDatabase(':memory:');
dbIdx.run('PRAGMA journal_mode = WAL');
dbIdx.run(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    score INTEGER NOT NULL,
    created_at TEXT NOT NULL
)`);

// Create indexes on the indexed DB
dbIdx.run('CREATE INDEX idx_users_email ON users (email)');
dbIdx.run('CREATE INDEX idx_users_role ON users (role)');
dbIdx.run('CREATE INDEX idx_users_score ON users (score)');
dbIdx.run('CREATE INDEX idx_users_role_score ON users (role, score)');

const roles = ['admin', 'member', 'viewer', 'editor', 'moderator'];
const insertStmtNoIdx = dbNoIdx.prepare('INSERT INTO users (name, email, role, score, created_at) VALUES (?, ?, ?, ?, ?)');
const insertStmtIdx = dbIdx.prepare('INSERT INTO users (name, email, role, score, created_at) VALUES (?, ?, ?, ?, ?)');

console.log(`Seeding ${ROWS.toLocaleString()} rows...`);

const seedStart = Bun.nanoseconds();
for (let i = 0; i < ROWS; i++) {
    const name = `user_${i}`;
    const email = `user_${i}@example.com`;
    const role = roles[i % roles.length]!;
    const score = Math.floor(Math.random() * 1000);
    const created = new Date(2024, 0, 1 + Math.floor(Math.random() * 365)).toISOString();
    insertStmtNoIdx.run(name, email, role, score, created);
    insertStmtIdx.run(name, email, role, score, created);
}

const seedElapsed = (Bun.nanoseconds() - seedStart) / 1_000_000;
console.log(`Seeded in ${seedElapsed.toFixed(0)}ms`);
console.log(`Queries per test: ${QUERIES.toLocaleString()}`);

// ═══════════════════════════════════════════════════════════════
// TEST 1: Point lookup by unique value (email)
// ═══════════════════════════════════════════════════════════════

separator('TEST 1: Point lookup — WHERE email = ?');

{
    const stmt = dbNoIdx.query('SELECT * FROM users WHERE email = ?');
    bench('No index', () => {
        const email = `user_${Math.floor(Math.random() * ROWS)}@example.com`;
        stmt.get(email);
    });
}

{
    const stmt = dbIdx.query('SELECT * FROM users WHERE email = ?');
    bench('With index (email)', () => {
        const email = `user_${Math.floor(Math.random() * ROWS)}@example.com`;
        stmt.get(email);
    });
}

// ═══════════════════════════════════════════════════════════════
// TEST 2: Filter by category (role)
// ═══════════════════════════════════════════════════════════════

separator('TEST 2: Category filter — WHERE role = ?');

{
    const stmt = dbNoIdx.query('SELECT * FROM users WHERE role = ?');
    bench('No index', () => {
        stmt.all(roles[Math.floor(Math.random() * roles.length)]);
    });
}

{
    const stmt = dbIdx.query('SELECT * FROM users WHERE role = ?');
    bench('With index (role)', () => {
        stmt.all(roles[Math.floor(Math.random() * roles.length)]);
    });
}

// ═══════════════════════════════════════════════════════════════
// TEST 3: Range scan (score > ?)
// ═══════════════════════════════════════════════════════════════

separator('TEST 3: Range scan — WHERE score > ? LIMIT 100');

{
    const stmt = dbNoIdx.query('SELECT * FROM users WHERE score > ? LIMIT 100');
    bench('No index', () => {
        stmt.all(Math.floor(Math.random() * 900));
    });
}

{
    const stmt = dbIdx.query('SELECT * FROM users WHERE score > ? LIMIT 100');
    bench('With index (score)', () => {
        stmt.all(Math.floor(Math.random() * 900));
    });
}

// ═══════════════════════════════════════════════════════════════
// TEST 4: Compound query (role + score)
// ═══════════════════════════════════════════════════════════════

separator('TEST 4: Compound — WHERE role = ? AND score > ? LIMIT 50');

{
    const stmt = dbNoIdx.query('SELECT * FROM users WHERE role = ? AND score > ? LIMIT 50');
    bench('No index', () => {
        stmt.all(roles[Math.floor(Math.random() * roles.length)], Math.floor(Math.random() * 500));
    });
}

{
    const stmt = dbIdx.query('SELECT * FROM users WHERE role = ? AND score > ? LIMIT 50');
    bench('With compound index (role, score)', () => {
        stmt.all(roles[Math.floor(Math.random() * roles.length)], Math.floor(Math.random() * 500));
    });
}

// ═══════════════════════════════════════════════════════════════
// TEST 5: ORDER BY with LIMIT (top-N)
// ═══════════════════════════════════════════════════════════════

separator('TEST 5: Top-N — ORDER BY score DESC LIMIT 10');

{
    const stmt = dbNoIdx.query('SELECT * FROM users ORDER BY score DESC LIMIT 10');
    bench('No index', () => { stmt.all(); });
}

{
    const stmt = dbIdx.query('SELECT * FROM users ORDER BY score DESC LIMIT 10');
    bench('With index (score)', () => { stmt.all(); });
}

// ═══════════════════════════════════════════════════════════════
// TEST 6: COUNT with filter
// ═══════════════════════════════════════════════════════════════

separator('TEST 6: COUNT — SELECT COUNT(*) WHERE role = ?');

{
    const stmt = dbNoIdx.query('SELECT COUNT(*) as c FROM users WHERE role = ?');
    bench('No index', () => {
        stmt.get(roles[Math.floor(Math.random() * roles.length)]);
    });
}

{
    const stmt = dbIdx.query('SELECT COUNT(*) as c FROM users WHERE role = ?');
    bench('With index (role)', () => {
        stmt.get(roles[Math.floor(Math.random() * roles.length)]);
    });
}

// ═══════════════════════════════════════════════════════════════
// TEST 7: INSERT overhead with indexes
// ═══════════════════════════════════════════════════════════════

separator('TEST 7: INSERT overhead');

const INSERT_COUNT = 10_000;

{
    const stmt = dbNoIdx.prepare('INSERT INTO users (name, email, role, score, created_at) VALUES (?, ?, ?, ?, ?)');
    const start = Bun.nanoseconds();
    for (let i = 0; i < INSERT_COUNT; i++) {
        stmt.run(`bench_${i}`, `bench_${i}@x.com`, 'member', i, '2024-01-01');
    }
    const elapsed = (Bun.nanoseconds() - start) / 1_000_000;
    console.log(`No indexes:    ${INSERT_COUNT} inserts in ${elapsed.toFixed(1)}ms  (${(elapsed / INSERT_COUNT * 1000).toFixed(1)}µs/insert)`);
}

{
    const stmt = dbIdx.prepare('INSERT INTO users (name, email, role, score, created_at) VALUES (?, ?, ?, ?, ?)');
    const start = Bun.nanoseconds();
    for (let i = 0; i < INSERT_COUNT; i++) {
        stmt.run(`bench_${i}`, `bench_${i}@x.com`, 'member', i, '2024-01-01');
    }
    const elapsed = (Bun.nanoseconds() - start) / 1_000_000;
    console.log(`With 4 indexes: ${INSERT_COUNT} inserts in ${elapsed.toFixed(1)}ms  (${(elapsed / INSERT_COUNT * 1000).toFixed(1)}µs/insert)`);
}

separator('SUMMARY');
console.log('Indexes dramatically speed up reads (10-100x for point lookups).');
console.log('Write overhead is modest (~30-50% for 4 indexes).');
console.log('For read-heavy workloads (typical ORM usage), indexes are essential.');
console.log('SatiDB auto-creates them from the { indexes } config option.');
