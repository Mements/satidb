/**
 * bench/poll-strategy.ts — Benchmark: MAX(id) vs SELECT WHERE for polling
 *
 * Tests the "no changes" hot path (the common case) to see if
 * checking MAX(id) first is actually faster than just doing
 * SELECT * FROM _changes WHERE id > ? ORDER BY id (which returns 0 rows).
 *
 * Run: bun bench/poll-strategy.ts
 */
import { Database as SqliteDatabase } from "bun:sqlite";

const ITERATIONS = 100_000;

// ── Setup ───────────────────────────────────────────────────

const db = new SqliteDatabase(":memory:");
db.run("PRAGMA journal_mode = WAL");

db.run(`CREATE TABLE IF NOT EXISTS _changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tbl TEXT NOT NULL,
    op TEXT NOT NULL,
    row_id INTEGER NOT NULL
)`);

// Seed some historical data then set watermark to max (simulates normal usage)
for (let i = 0; i < 1000; i++) {
  db.run(
    `INSERT INTO _changes (tbl, op, row_id) VALUES ('users', 'insert', ${i})`,
  );
}
const row = db.query("SELECT MAX(id) as m FROM _changes").get() as any;
const watermark = row.m;

// Clean up like the real poller does
db.run(`DELETE FROM _changes WHERE id <= ${watermark}`);

console.log(`Watermark: ${watermark}`);
console.log(
  `Rows in _changes after cleanup: ${(db.query("SELECT COUNT(*) as c FROM _changes").get() as any).c}`,
);
console.log(`Iterations: ${ITERATIONS.toLocaleString()}`);
console.log();

// ── Prepare statements ─────────────────────────────────────

const stmtMax = db.query("SELECT MAX(id) as m FROM _changes");
const stmtSelect = db.query(
  "SELECT id, tbl, op, row_id FROM _changes WHERE id > ? ORDER BY id",
);

// ── Strategy A: MAX(id) fast-path ──────────────────────────

{
  const start = Bun.nanoseconds();
  let skipped = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    const head = stmtMax.get() as any;
    const maxId = head?.m ?? 0;
    if (maxId <= watermark) {
      skipped++;
      continue;
    }
    // Would fetch rows here (never reached in this bench)
    stmtSelect.all(watermark);
  }

  const elapsed = (Bun.nanoseconds() - start) / 1_000_000;
  const perOp = (Bun.nanoseconds() - start) / ITERATIONS;

  console.log(`Strategy A: MAX(id) fast-path`);
  console.log(`  Total: ${elapsed.toFixed(1)}ms`);
  console.log(`  Per poll: ${perOp.toFixed(0)}ns`);
  console.log(`  Skipped: ${skipped}/${ITERATIONS}`);
  console.log();
}

// ── Strategy B: Direct SELECT WHERE (returns 0 rows) ───────

{
  const start = Bun.nanoseconds();
  let empty = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    const changes = stmtSelect.all(watermark);
    if (changes.length === 0) {
      empty++;
      continue;
    }
    // Would process rows here (never reached in this bench)
  }

  const elapsed = (Bun.nanoseconds() - start) / 1_000_000;
  const perOp = (Bun.nanoseconds() - start) / ITERATIONS;

  console.log(`Strategy B: Direct SELECT WHERE id > ?`);
  console.log(`  Total: ${elapsed.toFixed(1)}ms`);
  console.log(`  Per poll: ${perOp.toFixed(0)}ns`);
  console.log(`  Empty: ${empty}/${ITERATIONS}`);
  console.log();
}

// ── Strategy C: MAX(id) + SELECT WHERE (current implementation) ─

{
  const start = Bun.nanoseconds();
  let skipped = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    const head = stmtMax.get() as any;
    const maxId = head?.m ?? 0;
    if (maxId <= watermark) {
      skipped++;
      continue;
    }
    const changes = stmtSelect.all(watermark);
    // process...
  }

  const elapsed = (Bun.nanoseconds() - start) / 1_000_000;
  const perOp = (Bun.nanoseconds() - start) / ITERATIONS;

  console.log(`Strategy C: MAX(id) then SELECT WHERE (current impl)`);
  console.log(`  Total: ${elapsed.toFixed(1)}ms`);
  console.log(`  Per poll: ${perOp.toFixed(0)}ns`);
  console.log(`  Skipped: ${skipped}/${ITERATIONS}`);
  console.log();
}

// ── With pending changes (simulates active writes) ──────────

console.log("─".repeat(55));
console.log("With 5 pending changes per poll cycle:");
console.log();

const ITERATIONS_ACTIVE = 50_000;

// Strategy A with changes
{
  const start = Bun.nanoseconds();
  let wm = watermark;

  for (let i = 0; i < ITERATIONS_ACTIVE; i++) {
    // Seed 5 changes
    for (let j = 0; j < 5; j++) {
      db.run(
        `INSERT INTO _changes (tbl, op, row_id) VALUES ('users', 'insert', ${i * 5 + j})`,
      );
    }

    const head = stmtMax.get() as any;
    const maxId = head?.m ?? 0;
    if (maxId <= wm) continue;

    const changes = stmtSelect.all(wm) as any[];
    wm = changes[changes.length - 1].id;
    db.run(`DELETE FROM _changes WHERE id <= ${wm}`);
  }

  const elapsed = (Bun.nanoseconds() - start) / 1_000_000;
  const perOp = (Bun.nanoseconds() - start) / ITERATIONS_ACTIVE;

  console.log(`Strategy A+C: MAX(id) fast-path + SELECT`);
  console.log(`  Total: ${elapsed.toFixed(1)}ms`);
  console.log(`  Per poll: ${perOp.toFixed(0)}ns`);
  console.log();
}

// Strategy B with changes
{
  const start = Bun.nanoseconds();
  let wm = watermark;

  for (let i = 0; i < ITERATIONS_ACTIVE; i++) {
    for (let j = 0; j < 5; j++) {
      db.run(
        `INSERT INTO _changes (tbl, op, row_id) VALUES ('users', 'insert', ${i * 5 + j})`,
      );
    }

    const changes = stmtSelect.all(wm) as any[];
    if (changes.length === 0) continue;

    wm = changes[changes.length - 1].id;
    db.run(`DELETE FROM _changes WHERE id <= ${wm}`);
  }

  const elapsed = (Bun.nanoseconds() - start) / 1_000_000;
  const perOp = (Bun.nanoseconds() - start) / ITERATIONS_ACTIVE;

  console.log(`Strategy B: Direct SELECT WHERE id > ?`);
  console.log(`  Total: ${elapsed.toFixed(1)}ms`);
  console.log(`  Per poll: ${perOp.toFixed(0)}ns`);
  console.log();
}

console.log("─".repeat(55));
console.log("If A ≈ B in the hot path, the MAX check adds no value and");
console.log("costs an extra query in the active-changes case.");
