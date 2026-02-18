/**
 * messages-demo.ts — Reactivity demo: .on() vs .subscribe()
 *
 * Shows the two reactivity APIs working together:
 *
 *   .on('insert', callback)   → Row stream (one row at a time, in order)
 *   .on('update', callback)   → Row update stream (newRow, oldRow)
 *   .on('delete', callback)   → Row deletion stream (deletedRow)
 *   .subscribe(callback)      → Snapshot (full query result on change)
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
console.log('║   Reactivity Demo: .on() vs .subscribe()            ║');
console.log('╚══════════════════════════════════════════════════════╝');
console.log();

// ── .on('insert') — row stream (individual new messages) ─────

let onCount = 0;
const unsubOn = db.messages.on('insert', (msg) => {
    onCount++;
    console.log(`  📩 .on('insert') → New message #${msg.id}: ${msg.author} says "${msg.text}"`);
}, { interval: 150 });

// ── .on('update') — row change stream ──────────────────────

let updateCount = 0;
const unsubUpdate = db.messages.on('update', (msg, oldMsg) => {
    updateCount++;
    console.log(`  ✏️  .on('update') → #${msg.id}: "${oldMsg.text}" → "${msg.text}"`);
}, { interval: 150 });

// ── .on('delete') — row deletion stream ────────────────────

let deleteCount = 0;
const unsubDelete = db.messages.on('delete', (msg) => {
    deleteCount++;
    console.log(`  �️  .on('delete') → #${msg.id}: removed "${msg.text}"`);
}, { interval: 150 });

// ── .subscribe() — snapshot (full view on any change) ────────

let subCount = 0;
const unsubSnap = db.messages.select()
    .orderBy('id', 'asc')
    .subscribe((messages) => {
        subCount++;
        const summary = messages.map(m => {
            const e = m.edited ? '✏️' : '';
            return `${m.author}:"${m.text}"${e}`;
        }).join(', ');
        console.log(`  📋 .subscribe() → Snapshot #${subCount} (${messages.length} msgs): [${summary}]`);
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
    unsubOn();
    unsubUpdate();
    unsubDelete();
    unsubSnap();
    writer.close();
    console.log('══════════════════════════════════════════════════════');
    console.log(`✅ .on('insert') received ${onCount} new row events`);
    console.log(`   .on('update') received ${updateCount} row change events`);
    console.log(`   .on('delete') received ${deleteCount} row deletion events`);
    console.log(`   .subscribe()  fired ${subCount} snapshot updates`);
    console.log();
    console.log(`   .on('insert') = new rows, one at a time`);
    console.log(`   .on('update') = row changes with (newRow, oldRow)`);
    console.log(`   .on('delete') = row deletions`);
    console.log('   .subscribe()  = snapshot (full result on any change)');

    try {
        if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
        if (existsSync(DB_PATH + '-wal')) unlinkSync(DB_PATH + '-wal');
        if (existsSync(DB_PATH + '-shm')) unlinkSync(DB_PATH + '-shm');
    } catch { }
    process.exit(0);
}, 4500);
