/**
 * galaxy-db.test.ts — Tests for the Galaxy AI platform database
 *
 * Covers:
 *  - Users: CRUD, getOrCreate
 *  - Servers: CRUD, balance helpers, owner relationship
 *  - Members: join via relationship push, enrichment
 *  - Agent Templates: seeding, upsert idempotency
 *  - Agent Instances: deploying, linking via z.lazy()
 *  - Jobs: lifecycle (pending → running → completed), generation count
 *  - Generations: insert via relationship, enrich with user/instance
 *  - Messages: conversation thread queries via relationship
 *  - Relationship navigation: belongs-to, one-to-many, .push()
 *  - Indexes: verify all defined indexes exist
 */

import { describe, test, expect } from 'bun:test';
import { createGalaxyDb } from './galaxy-db';

const galaxy = createGalaxyDb(':memory:');
const { db } = galaxy;

// Store references for cross-test use
let systemUser: any;
let alice: any;
let bob: any;
let defaultServer: any;
let nanoBanana: any;

// =============================================================================
// SEED
// =============================================================================

describe('Galaxy DB — Seeding', () => {
    test('create system user and seed server', () => {
        systemUser = galaxy.getOrCreateUser('system');
        defaultServer = galaxy.seedDefaultServer(systemUser);

        expect(defaultServer).not.toBeNull();
        expect(defaultServer.name).toBe('Galaxy');
        expect(defaultServer.balance).toBe(1000);
    });

    test('templates are seeded', () => {
        const templates = db.agentTemplates.select().all();
        expect(templates.length).toBe(9);
    });

    test('instances are seeded with relationships', () => {
        const instances = db.agentInstances.select().where({ serverId: defaultServer.id } as any).all();
        expect(instances.length).toBe(2);

        // Navigate relationship: instance → template
        nanoBanana = db.agentInstances.select().where({ name: 'Nano Banana' }).get()!;
        const template = (nanoBanana as any).template();
        expect(template.name).toBe('Image Generator');
    });

    test('seedDefaultServer is idempotent (upsert)', () => {
        galaxy.seedDefaultServer(systemUser);  // call again
        expect(db.agentTemplates.select().all().length).toBe(9);
    });
});

// =============================================================================
// USERS
// =============================================================================

describe('Galaxy DB — Users', () => {
    test('getOrCreateUser creates new user', () => {
        alice = galaxy.getOrCreateUser('Alice');
        expect(alice.username).toBe('Alice');
    });

    test('getOrCreateUser returns existing user', () => {
        const user = galaxy.getOrCreateUser('Alice');
        expect(user.id).toBe(alice.id);  // Same entity, not duplicated
    });

    test('create another user', () => {
        bob = galaxy.getOrCreateUser('Bob');
        expect(bob.username).toBe('Bob');
    });
});

// =============================================================================
// SERVER BALANCE
// =============================================================================

describe('Galaxy DB — Server Balance', () => {
    test('getServerBalance returns balance', () => {
        expect(galaxy.getServerBalance(defaultServer.id)).toBe(1000);
    });

    test('updateServerBalance modifies balance', () => {
        galaxy.updateServerBalance(defaultServer.id, 750);
        expect(galaxy.getServerBalance(defaultServer.id)).toBe(750);
    });
});

// =============================================================================
// MEMBERS — using relationship .push()
// =============================================================================

describe('Galaxy DB — Members (via relationships)', () => {
    test('add members via relationship push', () => {
        // Add Alice as owner via server.members.push()
        const server = db.servers.get(defaultServer.id)!;
        (server as any).members.push({ role: 'owner', joinedAt: Date.now(), userId: alice.id });
        (server as any).members.push({ role: 'member', joinedAt: Date.now(), userId: bob.id });

        const members = db.members.select().where({ serverId: defaultServer.id } as any).all();
        expect(members.length).toBe(2);
    });

    test('getServerMembers enriches with user data', () => {
        const members = galaxy.getServerMembers(defaultServer.id);
        expect(members.length).toBe(2);

        const aliceMember = members.find((m: any) => m.user?.username === 'Alice');
        expect(aliceMember).toBeDefined();
    });

    test('navigate member → server (belongs-to)', () => {
        const member = db.members.select().where({ userId: alice.id } as any).get()!;
        const server = (member as any).server();
        expect(server.name).toBe('Galaxy');
    });

    test('navigate member → user (belongs-to)', () => {
        const member = db.members.select().where({ userId: bob.id } as any).get()!;
        const user = (member as any).user();
        expect(user.username).toBe('Bob');
    });
});

// =============================================================================
// JOBS + GENERATIONS — using relationships
// =============================================================================

describe('Galaxy DB — Jobs', () => {
    let jobId: number;

    test('create a job with relationships', () => {
        const job = db.jobs.insert({
            prompt: 'A cat wearing a top hat',
            status: 'pending',
            startedAt: Date.now(),
            userId: alice.id,
            instanceId: nanoBanana.id,
        } as any);
        jobId = job.id;

        expect(job).not.toBeNull();
        expect((job as any).status).toBe('pending');
    });

    test('navigate job → user (belongs-to)', () => {
        const job = db.jobs.get(jobId)!;
        const user = (job as any).user();
        expect(user.username).toBe('Alice');
    });

    test('navigate job → instance → template (chained belongs-to)', () => {
        const job = db.jobs.get(jobId)!;
        const instance = (job as any).instance();
        expect(instance.name).toBe('Nano Banana');
        const template = instance.template();
        expect(template.name).toBe('Image Generator');
    });

    test('updateJobStatus transitions job', () => {
        galaxy.updateJobStatus(jobId, 'running');
        expect(db.jobs.get(jobId)!.status).toBe('running');

        galaxy.updateJobStatus(jobId, 'completed', Date.now());
        const job = db.jobs.get(jobId)!;
        expect(job.status).toBe('completed');
        expect(job.completedAt).toBeDefined();
    });

    test('add generations and update count', () => {
        // Add 3 generations using the job relationship
        const job = db.jobs.get(jobId)!;
        for (let i = 0; i < 3; i++) {
            (job as any).generations.push({
                prompt: 'A cat wearing a top hat',
                outputUrl: `https://cdn.example.com/gen-${i}.png`,
                createdAt: Date.now(),
                userId: alice.id,
                instanceId: nanoBanana.id,
            });
        }

        galaxy.updateJobGenerationCount(jobId);

        const updated = db.jobs.get(jobId)!;
        expect(updated.generationCount).toBe(3);
        expect(updated.lastGenerationAt).toBeDefined();
    });

    test('navigate generation → job (belongs-to)', () => {
        const gen = db.generations.select().where({ jobId } as any).get()!;
        const job = (gen as any).job();
        expect(job.prompt).toBe('A cat wearing a top hat');
    });
});

// =============================================================================
// ENRICHMENT — uses relationship navigation
// =============================================================================

describe('Galaxy DB — Enrichment', () => {
    test('enrichServerWithOwner navigates owner relationship', () => {
        const server = db.servers.get(defaultServer.id)!;
        const enriched = galaxy.enrichServerWithOwner(server);
        expect(enriched.owner).toBeDefined();
        expect(enriched.owner.username).toBe('system');
    });

    test('enrichJob navigates user, instance, template', () => {
        const job = db.jobs.select().where({ status: 'completed' } as any).get()!;
        const enriched = galaxy.enrichJob(job);

        expect(enriched.user).toBeDefined();
        expect(enriched.user.username).toBe('Alice');
        expect(enriched.instance).toBeDefined();
        expect(enriched.instance.name).toBe('Nano Banana');
        expect(enriched.template).toBeDefined();
        expect(enriched.template.name).toBe('Image Generator');
    });

    test('enrichGeneration navigates user and instance', () => {
        const gen = db.generations.select().get()!;
        const enriched = galaxy.enrichGeneration(gen);

        expect(enriched.user.username).toBe('Alice');
        expect(enriched.instance.name).toBe('Nano Banana');
    });
});

// =============================================================================
// MESSAGES — via relationship
// =============================================================================

describe('Galaxy DB — Messages', () => {
    test('insert messages via relationship push', () => {
        const instance = db.agentInstances.select().where({ name: 'Nano Banana' }).get()!;
        const now = Date.now();

        // User sends message to agent
        (instance as any).messages.push({
            role: 'user',
            content: 'Generate a sunset',
            createdAt: now,
            userId: alice.id,
        });

        // Agent responds
        (instance as any).messages.push({
            role: 'agent',
            content: 'Here is your sunset image',
            createdAt: now + 1000,
            userId: alice.id,
            jobId: db.jobs.select().get()!.id,
        });

        const thread = db.messages.select()
            .where({ agentInstanceId: instance.id } as any)
            .orderBy('createdAt', 'asc')
            .all();

        expect(thread.length).toBe(2);
        expect(thread[0]!.role).toBe('user');
        expect(thread[1]!.role).toBe('agent');
    });

    test('navigate message → user (belongs-to)', () => {
        const msg = db.messages.select().get()!;
        const user = (msg as any).user();
        expect(user.username).toBe('Alice');
    });
});

// =============================================================================
// CUSTOM AGENTS
// =============================================================================

describe('Galaxy DB — Custom Agents', () => {
    test('insert custom agent with relationships', () => {
        db.customAgents.insert({
            name: 'My Custom Bot',
            code: 'export default { run() {} }',
            inputSchema: '{"type":"object"}',
            isPublic: true,
            price: 0,
            downloads: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            serverId: defaultServer.id,
            userId: alice.id,
        } as any);

        const agent = db.customAgents.select().where({ name: 'My Custom Bot' }).get()!;
        expect(agent).not.toBeNull();

        // Navigate to user and server
        const user = (agent as any).user();
        expect(user.username).toBe('Alice');
        const server = (agent as any).server();
        expect(server.name).toBe('Galaxy');
    });
});

// =============================================================================
// FLUENT QUERIES
// =============================================================================

describe('Galaxy DB — Fluent Queries', () => {
    test('filter jobs by status', () => {
        const completed = db.jobs.select().where({ status: 'completed' } as any).all();
        expect(completed.length).toBeGreaterThan(0);
    });

    test('count generations', () => {
        const count = db.generations.select().count();
        expect(count).toBe(3);
    });

    test('paginate templates', () => {
        const page1 = db.agentTemplates.select().orderBy('name', 'asc').limit(3).all();
        const page2 = db.agentTemplates.select().orderBy('name', 'asc').limit(3).offset(3).all();

        expect(page1.length).toBe(3);
        expect(page2.length).toBe(3);
        const page1Names = page1.map((t: any) => t.name);
        const page2Names = page2.map((t: any) => t.name);
        expect(page1Names.every((n: string) => !page2Names.includes(n))).toBe(true);
    });

    test('find active instances for a server', () => {
        const active = db.agentInstances.select()
            .where({ serverId: defaultServer.id, isActive: true } as any)
            .all();
        expect(active.length).toBe(2);
    });
});

// =============================================================================
// INDEXES
// =============================================================================

describe('Galaxy DB — Indexes', () => {
    test('relationship FK indexes exist', () => {
        const queryIndexes = (table: string) =>
            ((db as any).db
                .query(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='${table}'`)
                .all() as { name: string }[]).map(i => i.name);

        expect(queryIndexes('users')).toContain('idx_users_username');
        expect(queryIndexes('servers')).toContain('idx_servers_slug');
        expect(queryIndexes('members')).toContain('idx_members_serverId');
        expect(queryIndexes('members')).toContain('idx_members_serverId_userId');
        expect(queryIndexes('agentInstances')).toContain('idx_agentInstances_serverId_templateId');
        expect(queryIndexes('jobs')).toContain('idx_jobs_status');
        expect(queryIndexes('generations')).toContain('idx_generations_jobId');
        expect(queryIndexes('messages')).toContain('idx_messages_agentInstanceId_userId');
    });
});

// =============================================================================
// CHANGE TRACKING
// =============================================================================

describe('Galaxy DB — Change Tracking', () => {
    test('all mutation types are tracked', () => {
        const changes = db.getChangesSince(0);
        const actions = new Set(changes.map((c: any) => c.action));

        expect(actions.has('INSERT')).toBe(true);
        expect(actions.has('UPDATE')).toBe(true);
    });

    test('changes can be filtered by table', () => {
        const jobChanges = db.getChangesSince(0, 'jobs');
        expect(jobChanges.length).toBeGreaterThan(0);
        expect(jobChanges.every((c: any) => c.table_name === 'jobs')).toBe(true);
    });
});
