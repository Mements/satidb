/**
 * messages-demo.ts — Demonstrates db.table.on() change listeners
 *
 * Shows how to listen for insert, update, and delete events on a table.
 * Run: bun examples/messages-demo.ts
 */
import { Database, z } from '../src/index';

const db = new Database(':memory:', {
    messages: z.object({
        text: z.string(),
        author: z.string(),
    }),
});

// Pre-seed 2 rows
db.messages.insert({ text: 'Hello!', author: 'Alice' });
db.messages.insert({ text: 'Hi there', author: 'Bob' });

console.log('╔═════════════════════════════════════════════════╗');
console.log('║   db.table.on() — change listener demo         ║');
console.log('╚═════════════════════════════════════════════════╝');
console.log();

let insertCount = 0;
let updateCount = 0;
let deleteCount = 0;

// ── on('insert') ────────────────────────────────────────────
const unsubInsert = db.messages.on('insert', (msg) => {
    insertCount++;
    console.log(`  📩 INSERT → #${msg.id}: "${msg.text}" by ${msg.author}`);
});

// ── on('update') ────────────────────────────────────────────
const unsubUpdate = db.messages.on('update', (msg) => {
    updateCount++;
    console.log(`  ✏️  UPDATE → #${msg.id}: "${msg.text}" by ${msg.author}`);
});

// ── on('delete') ────────────────────────────────────────────
const unsubDelete = db.messages.on('delete', (row) => {
    deleteCount++;
    console.log(`  🗑️  DELETE → id=${row.id}`);
});

console.log('  Listeners registered. Starting mutations...\n');

// ── Mutations ───────────────────────────────────────────────

setTimeout(() => {
    console.log('  → Inserting message #3...');
    db.messages.insert({ text: 'Good morning!', author: 'Charlie' });
}, 150);

setTimeout(() => {
    console.log('  → Inserting message #4...');
    db.messages.insert({ text: 'How are you?', author: 'Alice' });
}, 300);

setTimeout(() => {
    console.log('  → Updating message #1...');
    db.messages.update(1, { text: 'Hello everyone! (edited)' });
}, 500);

setTimeout(() => {
    console.log('  → Deleting message #2...');
    db.messages.delete(2);
}, 700);

setTimeout(() => {
    console.log('  → Inserting message #5...');
    db.messages.insert({ text: 'Goodbye!', author: 'Bob' });
}, 900);

// ── Summary ─────────────────────────────────────────────────

setTimeout(() => {
    unsubInsert();
    unsubUpdate();
    unsubDelete();

    console.log();
    console.log('  ┌─ Summary ──────────────────────────────────────');
    console.log(`  │  on('insert') fired ${insertCount}x`);
    console.log(`  │  on('update') fired ${updateCount}x`);
    console.log(`  │  on('delete') fired ${deleteCount}x`);
    console.log('  │');
    console.log('  │  Key points:');
    console.log('  │  • Single global poller (default 100ms)');
    console.log('  │  • Row-level change tracking via SQLite triggers');
    console.log('  │  • INSERT/UPDATE callbacks receive the full row');
    console.log('  │  • DELETE callbacks receive { id } only');
    console.log('  │  • Cross-process changes detected automatically');
    console.log('  └────────────────────────────────────────────────');

    const remaining = db.messages.select().all();
    console.log(`\n  Final messages: ${remaining.length}`);
    for (const m of remaining) {
        console.log(`    #${m.id}: "${m.text}" by ${m.author}`);
    }

    process.exit(0);
}, 1200);
