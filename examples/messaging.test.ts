/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  SatiDB — Comprehensive Example                              ║
 * ║  A Messaging App: Groups → Contacts → Messages               ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * This single example demonstrates every SatiDB feature through
 * a realistic schema: users belong to groups, and messages are
 * exchanged between contacts within groups.
 *
 * Two query APIs, both mapping to natural SQL:
 *
 *   1. Fluent Builder  — db.messages.select().where({...}).all()
 *   2. Proxy Callback  — db.query(c => { ... })
 *
 *   bun test examples/messaging.test.ts
 */

import { test, expect } from 'bun:test';
import { SatiDB, z } from '../src/satidb';

// ═══════════════════════════════════════════════════════════════
// Type interfaces (break circular inference for z.lazy)
// ═══════════════════════════════════════════════════════════════

interface Group {
    name: string;
    memberships?: Membership[];
    messages?: Message[];
}

interface Contact {
    name: string;
    email?: string;
    memberships?: Membership[];
    sentMessages?: Message[];
}

interface Membership {
    contactId?: number;
    groupId?: number;
    role?: string;
    contact?: Contact;
    group?: Group;
}

interface Message {
    body: string;
    sentAt?: Date;
    groupId?: number;
    senderId?: number;
    group?: Group;
    sender?: Contact;
}

// ═══════════════════════════════════════════════════════════════
// Schema: Groups, Contacts, Messages, Memberships (M-M junction)
// ═══════════════════════════════════════════════════════════════

const GroupSchema: z.ZodType<Group> = z.object({
    name: z.string(),
    memberships: z.lazy(() => z.array(MembershipSchema)).optional(),
    messages: z.lazy(() => z.array(MessageSchema)).optional(),
});

const ContactSchema: z.ZodType<Contact> = z.object({
    name: z.string(),
    email: z.string().optional(),
    memberships: z.lazy(() => z.array(MembershipSchema)).optional(),
    sentMessages: z.lazy(() => z.array(MessageSchema)).optional(),
});

// Junction table: Contact ↔ Group (many-to-many)
const MembershipSchema: z.ZodType<Membership> = z.object({
    contactId: z.number().optional(),
    groupId: z.number().optional(),
    role: z.string().default('member'),
    contact: z.lazy(() => ContactSchema).optional(),
    group: z.lazy(() => GroupSchema).optional(),
});

const MessageSchema: z.ZodType<Message> = z.object({
    body: z.string(),
    sentAt: z.date().default(() => new Date()),
    groupId: z.number().optional(),
    senderId: z.number().optional(),
    group: z.lazy(() => GroupSchema).optional(),
    sender: z.lazy(() => ContactSchema).optional(),
});

// ═══════════════════════════════════════════════════════════════
// Database
// ═══════════════════════════════════════════════════════════════

const db = new SatiDB(':memory:', {
    groups: GroupSchema,
    contacts: ContactSchema,
    memberships: MembershipSchema,
    messages: MessageSchema,
}, {
    changeTracking: true,
    indexes: {
        contacts: ['email'],
        memberships: [['contactId', 'groupId']],  // composite unique-ish index
        messages: ['groupId', 'senderId'],
    },
});

// ═══════════════════════════════════════════════════════════════
// 1. INSERT — Seed the database
// ═══════════════════════════════════════════════════════════════

test('seed: insert groups, contacts, memberships, and messages', () => {
    // Groups
    const engineering = db.groups.insert({ name: 'Engineering' });
    const design = db.groups.insert({ name: 'Design' });

    // Contacts
    const alice = db.contacts.insert({ name: 'Alice', email: 'alice@co.dev' });
    const bob = db.contacts.insert({ name: 'Bob', email: 'bob@co.dev' });
    const carol = db.contacts.insert({ name: 'Carol', email: 'carol@co.dev' });

    // Memberships (many-to-many via junction)
    // FK constraints ensure contactId/groupId reference valid rows
    db.memberships.insert({ contactId: alice.id, groupId: engineering.id, role: 'lead' });
    db.memberships.insert({ contactId: alice.id, groupId: design.id, role: 'member' });
    db.memberships.insert({ contactId: bob.id, groupId: engineering.id });
    db.memberships.insert({ contactId: carol.id, groupId: design.id, role: 'lead' });
    db.memberships.insert({ contactId: carol.id, groupId: engineering.id });

    // Messages in Engineering
    db.messages.insert({ body: 'Sprint starts Monday', groupId: engineering.id, senderId: alice.id });
    db.messages.insert({ body: 'PR #42 ready for review', groupId: engineering.id, senderId: bob.id });
    db.messages.insert({ body: 'I will review it', groupId: engineering.id, senderId: carol.id });
    db.messages.insert({ body: 'Merged, thanks!', groupId: engineering.id, senderId: bob.id });

    // Messages in Design
    db.messages.insert({ body: 'New mockups uploaded', groupId: design.id, senderId: carol.id });
    db.messages.insert({ body: 'Looks great!', groupId: design.id, senderId: alice.id });

    expect(db.messages.select().count()).toBe(6);
    expect(db.contacts.select().count()).toBe(3);
    expect(db.memberships.select().count()).toBe(5);
});

// ═══════════════════════════════════════════════════════════════
// 2. FLUENT BUILDER — select().where().orderBy().limit()
// ═══════════════════════════════════════════════════════════════

test('builder: fetch messages in a specific group', () => {
    const engineering = db.groups.select().where({ name: 'Engineering' }).get()!;
    const msgs = db.messages.select()
        .where({ groupId: engineering.id })
        .orderBy('id', 'asc')
        .all();

    expect(msgs.length).toBe(4);
    expect(msgs[0]!.body).toBe('Sprint starts Monday');
    expect(msgs[3]!.body).toBe('Merged, thanks!');
});

test('builder: callback WHERE with SQL functions', () => {
    // Case-insensitive search using f.lower()
    const found = db.contacts.select()
        .where((c, f, op) => op.eq(f.lower(c.name), 'alice'))
        .get();

    expect(found).not.toBeNull();
    expect(found!.name).toBe('Alice');
});

test('builder: composable AND / OR', () => {
    const engineering = db.groups.select().where({ name: 'Engineering' }).get()!;

    // Messages from Engineering where sender is Alice OR Bob
    const msgs = db.messages.select()
        .where((c, f, op) => op.and(
            op.eq(c.groupId, engineering.id),
            op.or(op.eq(c.senderId, 1), op.eq(c.senderId, 2)),
        ))
        .all();

    expect(msgs.length).toBe(3);
});

test('builder: pagination', () => {
    const page1 = db.messages.select().orderBy('id', 'asc').limit(3).all();
    const page2 = db.messages.select().orderBy('id', 'asc').limit(3).offset(3).all();

    expect(page1.length).toBe(3);
    expect(page2.length).toBe(3);
    expect(page1[2].id).toBeLessThan(page2[0].id);
});

test('builder: count() with filters', () => {
    const engineering = db.groups.select().where({ name: 'Engineering' }).get()!;

    expect(db.messages.select().where({ groupId: engineering.id }).count()).toBe(4);
    expect(db.messages.select().where((c, f, op) => op.gt(c.id, 3)).count()).toBe(3);
});

test('builder: thenable / await', async () => {
    const msgs = await db.messages.select().where({ groupId: 1 });
    expect(msgs.length).toBe(4);
});

// ═══════════════════════════════════════════════════════════════
// 3. PROXY CALLBACK — db.query(c => { ... })
// ═══════════════════════════════════════════════════════════════

test('proxy: join messages with sender name and group name', () => {
    const rows = db.query(c => {
        const { messages: m, contacts: s, groups: g } = c;
        return {
            select: { body: m.body, sender: s.name, group: g.name },
            join: [[m.senderId, s.id], [m.groupId, g.id]],
            where: { [g.name]: 'Engineering' },
            orderBy: { [m.id]: 'asc' },
        };
    });

    expect(rows.length).toBe(4);
    expect((rows[0] as any).sender).toBe('Alice');
    expect((rows[0] as any).group).toBe('Engineering');
    expect((rows[1] as any).sender).toBe('Bob');
});

test('proxy: find all groups a contact belongs to', () => {
    const rows = db.query(c => {
        const { memberships: m, contacts: ct, groups: g } = c;
        return {
            select: { group: g.name, role: m.role },
            join: [[m.contactId, ct.id], [m.groupId, g.id]],
            where: { [ct.name]: 'Alice' },
        };
    });

    expect(rows.length).toBe(2);
    const groups = rows.map((r: any) => r.group).sort();
    expect(groups).toEqual(['Design', 'Engineering']);
});

test('proxy: messages from contacts in a specific group', () => {
    const rows = db.query(c => {
        const { messages: m, memberships: mb, contacts: ct, groups: g } = c;
        return {
            select: { body: m.body, sender: ct.name },
            join: [
                [m.senderId, ct.id],
                [m.groupId, g.id],
                [mb.contactId, ct.id],
            ],
            where: { [g.name]: 'Engineering', [mb.groupId]: { $gt: 0 } },
            orderBy: { [m.id]: 'asc' },
        };
    });

    // All engineering messages from contacts who are members
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: any) => typeof r.sender === 'string')).toBe(true);
});

// ═══════════════════════════════════════════════════════════════
// 4. RELATIONSHIPS — One-to-Many, Belongs-To, Many-to-Many
// ═══════════════════════════════════════════════════════════════

test('one-to-many: find messages sent by a contact', () => {
    const bob = db.contacts.select().where({ name: 'Bob' }).get()!;
    const msgs = db.messages.select().where({ senderId: bob.id }).all();

    expect(msgs.length).toBe(2);
    expect(msgs.every(m => m.senderId === bob.id)).toBe(true);
});

test('belongs-to: find the sender of a message', () => {
    const msg = db.messages.select().where({ body: 'Looks great!' }).get()!;
    const sender = db.contacts.select().where({ id: msg.senderId! }).get()!;

    expect(sender.name).toBe('Alice');
});

test('many-to-many: group → memberships → contacts', () => {
    const engineering = db.groups.select().where({ name: 'Engineering' }).get()!;
    const memberships = db.memberships.select().where({ groupId: engineering.id }).all();
    const names = memberships.map(m => {
        const contact = db.contacts.select().where({ id: m.contactId }).get()!;
        return contact.name;
    }).sort();

    expect(names).toEqual(['Alice', 'Bob', 'Carol']);
});

test('many-to-many: contact → memberships → groups', () => {
    const carol = db.contacts.select().where({ name: 'Carol' }).get()!;
    const memberships = db.memberships.select().where({ contactId: carol.id }).all();
    const names = memberships.map(m => {
        const group = db.groups.select().where({ id: m.groupId }).get()!;
        return group.name;
    }).sort();

    expect(names).toEqual(['Design', 'Engineering']);
});

// ═══════════════════════════════════════════════════════════════
// 5. UPDATE & DELETE
// ═══════════════════════════════════════════════════════════════

test('entity.update() persists changes', () => {
    const alice = db.contacts.select().where({ name: 'Alice' }).get()!;
    alice.update({ email: 'alice.new@co.dev' });

    const refetched = db.contacts.select().where({ name: 'Alice' }).get()!;
    expect(refetched.email).toBe('alice.new@co.dev');
});

test('reactive property assignment auto-persists', () => {
    const bob = db.contacts.select().where({ name: 'Bob' }).get()!;
    bob.email = 'bob.updated@co.dev';

    const refetched = db.contacts.select().where({ id: bob.id }).get()!;
    expect(refetched.email).toBe('bob.updated@co.dev');
});

test('delete by id', () => {
    const msg = db.messages.insert({ body: 'temp message', groupId: 1, senderId: 1 });
    const before = db.messages.select().count();

    db.messages.delete(msg.id);

    expect(db.messages.select().count()).toBe(before - 1);
    expect(db.messages.select().where({ id: msg.id }).get()).toBeNull();
});

test('upsert: insert-or-update in one call', () => {
    const g1 = db.groups.upsert({ name: 'Ops' }, { name: 'Ops' });
    const g2 = db.groups.upsert({ name: 'Ops' }, { name: 'Operations' });

    expect(g2.id).toBe(g1.id);
    expect(g2.name).toBe('Operations');
});

// ═══════════════════════════════════════════════════════════════
// 6. SUBSCRIBE — Smart Polling on QueryBuilder
// ═══════════════════════════════════════════════════════════════

test('subscribe: detects new rows via COUNT+MAX(id) fingerprint', async () => {
    const snapshots: number[] = [];

    // Subscribe to engineering messages
    const unsub = db.messages.select()
        .where({ groupId: 1 })
        .subscribe((rows) => {
            snapshots.push(rows.length);
        }, { interval: 50 });

    // Initial call fires immediately → snapshots[0]
    expect(snapshots.length).toBe(1);

    // Insert a new message → fingerprint changes on next poll
    db.messages.insert({ body: 'New task assigned', groupId: 1, senderId: 2 });

    // Wait for the next poll tick
    await new Promise(r => setTimeout(r, 100));

    // Callback should have fired again with the new row
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect(snapshots[snapshots.length - 1]).toBe(snapshots[0] + 1);

    unsub();
});

test('subscribe: does NOT fire when unrelated data changes', async () => {
    let callCount = 0;

    // Subscribe to Design group messages only
    const design = db.groups.select().where({ name: 'Design' }).get()!;
    const unsub = db.messages.select()
        .where({ groupId: design.id })
        .subscribe(() => {
            callCount++;
        }, { interval: 50 });

    // Initial fire
    expect(callCount).toBe(1);

    // Insert into Engineering (different group) — should NOT trigger
    db.messages.insert({ body: 'Irrelevant', groupId: 1, senderId: 1 });
    await new Promise(r => setTimeout(r, 100));

    // callCount should still be 1 because fingerprint of Design didn't change
    expect(callCount).toBe(1);

    unsub();
});

test('subscribe: unsubscribe stops polling', async () => {
    let callCount = 0;

    const unsub = db.messages.select()
        .subscribe(() => { callCount++; }, { interval: 30 });

    expect(callCount).toBe(1);
    unsub();

    // Insert after unsubscribe — callback should NOT fire
    db.messages.insert({ body: 'After unsub', groupId: 1, senderId: 1 });
    await new Promise(r => setTimeout(r, 100));

    expect(callCount).toBe(1);
});

// ═══════════════════════════════════════════════════════════════
// 8. INDEXES — Verify index creation
// ═══════════════════════════════════════════════════════════════

test('indexes: single-column index on contacts.email', () => {
    const indexes = (db as any).db
        .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='contacts'")
        .all() as { name: string }[];
    const indexNames = indexes.map(i => i.name);

    expect(indexNames).toContain('idx_contacts_email');
});

test('indexes: composite index on memberships(contactId, groupId)', () => {
    const indexes = (db as any).db
        .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memberships'")
        .all() as { name: string }[];
    const indexNames = indexes.map(i => i.name);

    expect(indexNames).toContain('idx_memberships_contactId_groupId');
});

test('indexes: multiple indexes on messages table', () => {
    const indexes = (db as any).db
        .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages'")
        .all() as { name: string }[];
    const indexNames = indexes.map(i => i.name);

    expect(indexNames).toContain('idx_messages_groupId');
    expect(indexNames).toContain('idx_messages_senderId');
});

// ═══════════════════════════════════════════════════════════════
// 9. CHANGE TRACKING — Trigger-based change log
// ═══════════════════════════════════════════════════════════════

test('change tracking: inserts are logged in _sati_changes', () => {
    // All seed data inserts should be tracked
    const seq = db.getChangeSeq('contacts');
    expect(seq).toBeGreaterThan(0);

    const changes = db.getChangesSince(0, 'contacts');
    // We inserted 3 contacts in the seed
    const insertChanges = changes.filter(c => c.action === 'INSERT');
    expect(insertChanges.length).toBeGreaterThanOrEqual(3);
});

test('change tracking: updates are logged', () => {
    const seqBefore = db.getChangeSeq('contacts');

    // Update a contact
    const alice = db.contacts.select().where({ name: 'Alice' }).get()!;
    db.contacts.update(alice.id, { email: 'alice-new@co.dev' });

    const changes = db.getChangesSince(seqBefore, 'contacts');
    expect(changes.length).toBe(1);
    expect(changes[0]!.action).toBe('UPDATE');
    expect(changes[0]!.row_id).toBe(alice.id);

    // Revert for other tests
    db.contacts.update(alice.id, { email: 'alice@co.dev' });
});

test('change tracking: deletes are logged', () => {
    // Insert a temporary contact
    const temp = db.contacts.insert({ name: 'Temp' });
    const seqAfterInsert = db.getChangeSeq('contacts');

    db.contacts.delete(temp.id);

    const changes = db.getChangesSince(seqAfterInsert, 'contacts');
    expect(changes.length).toBe(1);
    expect(changes[0]!.action).toBe('DELETE');
    expect(changes[0]!.row_id).toBe(temp.id);
});

test('change tracking: getChangeSeq returns -1 when tracking disabled', () => {
    // Create a DB without change tracking
    const plainDb = new SatiDB(':memory:', {
        items: z.object({ name: z.string() }),
    });
    expect(plainDb.getChangeSeq()).toBe(-1);
});

// ═══════════════════════════════════════════════════════════════
// 10. MIGRATIONS — Auto-add missing columns
// ═══════════════════════════════════════════════════════════════

test('migrations: auto-adds new columns when schema evolves', () => {
    const { join } = require('path');
    const { unlinkSync } = require('fs');
    const dbPath = join(import.meta.dir, `_test_migration_${Date.now()}.db`);

    try {
        // Step 1: Create a DB with a simple schema
        const dbA = new SatiDB(dbPath, {
            users: z.object({ name: z.string() }),
        });
        dbA.users.insert({ name: 'Bob' });
        expect(dbA.users.select().all().length).toBe(1);

        // Step 2: Reopen with an extra column — migration should add it
        const dbB = new SatiDB(dbPath, {
            users: z.object({
                name: z.string(),
                email: z.string().optional(),
            }),
        });

        // The existing row should still be accessible
        const all = dbB.users.select().all();
        const bob = all.find((u: any) => u.name === 'Bob');
        expect(bob).toBeDefined();
        expect(bob!.name).toBe('Bob');

        // New rows can use the new column
        dbB.users.insert({ name: 'Carol', email: 'carol@test.com' });
        const carol = dbB.users.select().all().find((u: any) => u.name === 'Carol');
        expect(carol).toBeDefined();
        expect(carol!.email).toBe('carol@test.com');
    } finally {
        try { unlinkSync(dbPath); } catch { }
    }
});

test('migrations: tracks added columns in _sati_meta', () => {
    const { join } = require('path');
    const { unlinkSync } = require('fs');
    const dbPath = join(import.meta.dir, `_test_meta_${Date.now()}.db`);

    try {
        // Create initial schema
        new SatiDB(dbPath, {
            tasks: z.object({ title: z.string() }),
        });

        // Reopen with new column
        const db2 = new SatiDB(dbPath, {
            tasks: z.object({
                title: z.string(),
                priority: z.number().optional(),
            }),
        });

        // Check _sati_meta recorded the migration
        const meta = (db2 as any).db
            .query("SELECT * FROM _sati_meta WHERE table_name = 'tasks' AND column_name = 'priority'")
            .all();
        expect(meta.length).toBe(1);
    } finally {
        try { unlinkSync(dbPath); } catch { }
    }
});
