/**
 * messages-demo.ts — Multi-process messaging demo
 *
 * Demonstrates that select().subscribe() detects changes from ANOTHER process:
 *
 *  Process A (this file):  Watches messages with .subscribe()
 *  Process B (writer):     Inserts, edits, and deletes messages via raw SQL
 *
 * The watcher never calls insert/update/delete — it only reads.
 * Yet it detects all changes via PRAGMA data_version.
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

// ─── Watcher (ORM connection — only reads, never writes) ─────

const db = new Database(DB_PATH, {
    messages: MessageSchema,
});

console.log('╔══════════════════════════════════════════════════════╗');
console.log('║   Multi-Process Messaging Demo                      ║');
console.log('║                                                     ║');
console.log('║   Watcher:  ORM connection with select().subscribe  ║');
console.log('║   Writer:   Separate SQLite connection (raw SQL)    ║');
console.log('╚══════════════════════════════════════════════════════╝');
console.log();

let updateCount = 0;

const unsub = db.messages.select()
    .orderBy('id', 'asc')
    .subscribe((messages) => {
        updateCount++;
        const ts = new Date().toLocaleTimeString();
        console.log(`  [watcher] Change #${updateCount} detected — ${messages.length} message(s):`);
        for (const msg of messages) {
            const editTag = msg.edited ? ' ✏️' : '';
            console.log(`            #${msg.id}  ${msg.author}: "${msg.text}"${editTag}`);
        }
        console.log();
    }, { interval: 150 });

// ─── Writer (separate connection — simulates another process) ─

const writer = new RawDB(DB_PATH);
writer.run('PRAGMA journal_mode = WAL');

const actions: Array<[number, () => void]> = [
    [600, () => {
        writer.run(`INSERT INTO messages (text, author, edited) VALUES (?, ?, 0)`, 'Hey everyone!', 'Alice');
        console.log('  [writer]  Alice sent: "Hey everyone!"');
    }],
    [1200, () => {
        writer.run(`INSERT INTO messages (text, author, edited) VALUES (?, ?, 0)`, 'Hi Alice!', 'Bob');
        console.log('  [writer]  Bob sent: "Hi Alice!"');
    }],
    [1800, () => {
        writer.run(`INSERT INTO messages (text, author, edited) VALUES (?, ?, 0)`, 'What are you working on?', 'Alice');
        console.log('  [writer]  Alice sent: "What are you working on?"');
    }],
    [2400, () => {
        writer.run(`UPDATE messages SET text = ?, edited = 1 WHERE id = 1`, 'Hey everyone! 👋');
        console.log('  [writer]  Alice EDITED msg #1 → "Hey everyone! 👋"');
    }],
    [3000, () => {
        writer.run(`INSERT INTO messages (text, author, edited) VALUES (?, ?, 0)`, 'Building a real-time chat ORM!', 'Bob');
        console.log('  [writer]  Bob sent: "Building a real-time chat ORM!"');
    }],
    [3600, () => {
        writer.run(`UPDATE messages SET text = ?, edited = 1 WHERE id = 2`, 'Hi Alice! How are you?');
        console.log('  [writer]  Bob EDITED msg #2 → "Hi Alice! How are you?"');
    }],
    [4200, () => {
        writer.run(`DELETE FROM messages WHERE id = 3`);
        console.log('  [writer]  Alice DELETED msg #3');
    }],
    [4800, () => {
        writer.run(`INSERT INTO messages (text, author, edited) VALUES (?, ?, 0)`, 'That sounds amazing!', 'Charlie');
        console.log('  [writer]  Charlie sent: "That sounds amazing!"');
    }],
];

for (const [delay, action] of actions) {
    setTimeout(action, delay);
}

// Finish
setTimeout(() => {
    unsub();
    writer.close();
    console.log('══════════════════════════════════════════════════════');
    console.log(`✅ Demo complete — watcher detected ${updateCount} change events`);
    console.log('   across INSERT, UPDATE, and DELETE from another connection.');
    console.log('   No triggers. No _changes table. Just PRAGMA data_version.');

    try {
        if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
        if (existsSync(DB_PATH + '-wal')) unlinkSync(DB_PATH + '-wal');
        if (existsSync(DB_PATH + '-shm')) unlinkSync(DB_PATH + '-shm');
    } catch { }
    process.exit(0);
}, 5800);
