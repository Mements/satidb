/**
 * messages-demo.ts — Reactivity demo with clear annotations
 *
 * Two reactive primitives:
 *   .each(cb)       → Row stream: emits one row at a time, uses id watermark
 *   .subscribe(cb)  → Snapshot:   emits full result array on any change
 *
 * Run:  bun examples/messages-demo.ts
 */
import { z } from 'zod';
import { Database } from '../src/database';
import { Database as RawDB } from 'bun:sqlite';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const DB_PATH = join(tmpdir(), `messages-demo-${Date.now()}.db`);

const MessageSchema = z.object({
    text: z.string(),
    author: z.string(),
});

const db = new Database(DB_PATH, { messages: MessageSchema }, { pollInterval: 100 });

// Pre-seed 2 rows so we can prove .each() skips them
db.messages.insert({ text: 'Old message 1', author: 'System' });
db.messages.insert({ text: 'Old message 2', author: 'System' });

console.log('╔═══════════════════════════════════════════════════════════╗');
console.log('║   .each() vs .subscribe() — how they differ             ║');
console.log('╚═══════════════════════════════════════════════════════════╝');
console.log();
console.log(`  📦 Pre-seeded 2 rows (id=1, id=2)`);
console.log();

// ── .each() — watermark-based, skips existing rows ──────────

console.log('  ┌─ .each() starts ─────────────────────────────────────');
console.log('  │  Watermark initialized to MAX(id)=2');
console.log('  │  Will only emit rows with id > 2');
console.log('  └──────────────────────────────────────────────────────');

let eachCount = 0;
const unsubEach = db.messages.select().each((msg) => {
    eachCount++;
    console.log(`  📩 .each()      → row #${msg.id}: "${msg.text}" by ${msg.author}  (watermark advances to ${msg.id})`);
}, { interval: 100 });

// ── .subscribe() — snapshot, fires immediately with current state ─

console.log();
console.log('  ┌─ .subscribe() starts ────────────────────────────────');
console.log('  │  Fires immediately with current full result');
console.log('  │  Then re-fires on every change (fingerprint-based)');
console.log('  └──────────────────────────────────────────────────────');

let snapCount = 0;
const unsubSnap = db.messages.select()
    .orderBy('id', 'asc')
    .subscribe((messages) => {
        snapCount++;
        const ids = messages.map(m => m.id).join(',');
        console.log(`  📋 .subscribe() → snapshot #${snapCount}: ${messages.length} rows [ids: ${ids}]`);
    }, { interval: 100 });

// ─── Writer (separate connection to prove cross-process detection) ─

const writer = new RawDB(DB_PATH);
writer.run('PRAGMA journal_mode = WAL');

console.log();

const actions: Array<[number, string, () => void]> = [
    [400, 'INSERT id=3', () => {
        writer.run(`INSERT INTO messages (text, author) VALUES (?, ?)`, 'Hello!', 'Alice');
    }],
    [1000, 'INSERT id=4', () => {
        writer.run(`INSERT INTO messages (text, author) VALUES (?, ?)`, 'Hi Alice!', 'Bob');
    }],
    [1600, 'UPDATE id=3', () => {
        writer.run(`UPDATE messages SET text = ? WHERE id = 3`, 'Hello everyone!');
    }],
    [2200, 'DELETE id=1', () => {
        writer.run(`DELETE FROM messages WHERE id = 1`);
    }],
    [2800, 'INSERT id=5', () => {
        writer.run(`INSERT INTO messages (text, author) VALUES (?, ?)`, 'Nice!', 'Charlie');
    }],
];

for (const [delay, label, action] of actions) {
    setTimeout(() => {
        console.log(`\n  ✍️  [writer] ${label}`);
        action();
    }, delay);
}

setTimeout(() => {
    unsubEach();
    unsubSnap();
    writer.close();

    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  Summary:');
    console.log(`    .each()      fired ${eachCount}x (only INSERTs — ids 3, 4, 5)`);
    console.log(`    .subscribe() fired ${snapCount}x (on ANY change — inserts, updates, deletes)`);
    console.log();
    console.log('  Key differences:');
    console.log('    .each()      → one row at a time, watermark-based, O(new_rows)');
    console.log('    .subscribe() → full result array, fingerprint-based, O(query)');
    console.log('    .each()      ignores updates/deletes (watermark only moves forward)');
    console.log('    .subscribe() catches everything (snapshot changes on any mutation)');

    try {
        if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
        if (existsSync(DB_PATH + '-wal')) unlinkSync(DB_PATH + '-wal');
        if (existsSync(DB_PATH + '-shm')) unlinkSync(DB_PATH + '-shm');
    } catch { }
    process.exit(0);
}, 3800);
