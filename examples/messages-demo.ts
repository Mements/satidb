/**
 * messages-demo.ts — Reactivity demo: .subscribe()
 *
 * .subscribe() is the single reactive primitive. Two patterns:
 *
 *   Snapshot:  .select().subscribe(cb)           → full result on any change
 *   Watermark: .select().where({ id: { $gt } }) → only new rows since X
 *
 * Writer uses a separate SQLite connection to prove cross-process detection.
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

// ─── Schema ──────────────────────────────────────────────────

const MessageSchema = z.object({
    text: z.string(),
    author: z.string(),
    edited: z.number().default(0),
});

// ─── Watcher (ORM — only reads, never writes) ───────────────

const db = new Database(DB_PATH, {
    messages: MessageSchema,
});

console.log('╔══════════════════════════════════════════════════════╗');
console.log('║   Reactivity Demo: .subscribe()                     ║');
console.log('╚══════════════════════════════════════════════════════╝');
console.log();

// ── Pattern 1: Watermark — new rows only ─────────────────────

let watermark = 0;
let newCount = 0;
const unsubNew = db.messages.select()
    .where({ id: { $gt: watermark } })
    .orderBy('id', 'asc')
    .subscribe((rows) => {
        for (const row of rows) {
            if (row.id > watermark) {
                newCount++;
                console.log(`  📩 [watermark] New #${row.id}: ${row.author} says "${row.text}"`);
                watermark = row.id;
            }
        }
    }, { interval: 150 });

// ── Pattern 2: Snapshot — full view on any change ────────────

let snapCount = 0;
const unsubSnap = db.messages.select()
    .orderBy('id', 'asc')
    .subscribe((messages) => {
        snapCount++;
        const summary = messages.map(m => {
            const e = m.edited ? '✏️' : '';
            return `${m.author}:"${m.text}"${e}`;
        }).join(', ');
        console.log(`  📋 [snapshot]  #${snapCount} (${messages.length} msgs): [${summary}]`);
        console.log();
    }, { interval: 150 });

// ─── Writer (separate connection) ────────────────────────────

const writer = new RawDB(DB_PATH);
writer.run('PRAGMA journal_mode = WAL');

const actions: Array<[number, () => void]> = [
    [500, () => {
        writer.run(`INSERT INTO messages (text, author, edited) VALUES (?, ?, 0)`, 'Hey everyone!', 'Alice');
        console.log('  ✍️  [writer] Alice: "Hey everyone!"');
    }],
    [1200, () => {
        writer.run(`INSERT INTO messages (text, author, edited) VALUES (?, ?, 0)`, 'Hi Alice!', 'Bob');
        console.log('  ✍️  [writer] Bob: "Hi Alice!"');
    }],
    [1900, () => {
        writer.run(`UPDATE messages SET text = ?, edited = 1 WHERE id = 1`, 'Hey everyone! 👋');
        console.log('  ✍️  [writer] Alice EDITED #1 → "Hey everyone! 👋"');
    }],
    [2600, () => {
        writer.run(`INSERT INTO messages (text, author, edited) VALUES (?, ?, 0)`, 'Nice ORM!', 'Charlie');
        console.log('  ✍️  [writer] Charlie: "Nice ORM!"');
    }],
    [3300, () => {
        writer.run(`DELETE FROM messages WHERE id = 2`);
        console.log('  ✍️  [writer] Bob DELETED #2');
    }],
];

for (const [delay, action] of actions) {
    setTimeout(action, delay);
}

setTimeout(() => {
    unsubNew();
    unsubSnap();
    writer.close();
    console.log('══════════════════════════════════════════════════════');
    console.log(`✅ [watermark] detected ${newCount} new rows`);
    console.log(`   [snapshot]  fired ${snapCount} snapshot updates`);
    console.log();
    console.log('   One primitive: .subscribe()');
    console.log('   Watermark pattern: .where({ id: { $gt: N } }) = new rows');
    console.log('   Snapshot pattern:  .select().subscribe()       = full view');

    try {
        if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
        if (existsSync(DB_PATH + '-wal')) unlinkSync(DB_PATH + '-wal');
        if (existsSync(DB_PATH + '-shm')) unlinkSync(DB_PATH + '-shm');
    } catch { }
    process.exit(0);
}, 4500);
