/**
 * galaxy-db.test.ts — Tests for the Galaxy AI platform database
 *
 * Covers:
 *  - Users: CRUD, getOrCreate
 *  - Servers: CRUD, balance helpers
 *  - Members: join/leave, getServerMembers with user enrichment
 *  - Agent Templates: seeding, upsert idempotency
 *  - Agent Instances: deploying, linking to templates
 *  - Jobs: lifecycle (pending → running → completed), generation count
 *  - Generations: insert, enrich with user/instance
 *  - Messages: conversation thread queries
 *  - Indexes: verify all defined indexes exist
 */

import { describe, test, expect } from 'bun:test';
import { createGalaxyDb } from './galaxy-db';

const galaxy = createGalaxyDb(':memory:');
const { db } = galaxy;

// =============================================================================
// SEED
// =============================================================================

describe('Galaxy DB — Seeding', () => {
    test('seedDefaultServer creates server, templates, and instances', () => {
        galaxy.seedDefaultServer();

        const server = db.servers.select().where({ serverId: 'default' }).get();
        expect(server).not.toBeNull();
        expect(server!.name).toBe('Galaxy');
        expect(server!.balance).toBe(1000);

        const templates = db.agentTemplates.select().all();
        expect(templates.length).toBe(9);

        const instances = db.agentInstances.select().where({ serverId: 'default' }).all();
        expect(instances.length).toBe(2);
    });

    test('seedDefaultServer is idempotent (upsert)', () => {
        galaxy.seedDefaultServer();  // call again

        // Still 9 templates, not 18
        expect(db.agentTemplates.select().all().length).toBe(9);
        expect(db.agentInstances.select().where({ serverId: 'default' }).all().length).toBe(2);
    });
});

// =============================================================================
// USERS
// =============================================================================

describe('Galaxy DB — Users', () => {
    test('getOrCreateUser creates new user', () => {
        const user = galaxy.getOrCreateUser('u-alice', 'Alice');
        expect(user.userId).toBe('u-alice');
        expect(user.username).toBe('Alice');
    });

    test('getOrCreateUser returns existing user', () => {
        const user = galaxy.getOrCreateUser('u-alice', 'AliceDuplicate');
        expect(user.username).toBe('Alice');  // Not overwritten
    });

    test('getOrCreateUser auto-generates username', () => {
        const user = galaxy.getOrCreateUser('u-bob-longuuid-12345');
        expect(user.username).toBe('user_u-bob-lo');
    });
});

// =============================================================================
// SERVER BALANCE
// =============================================================================

describe('Galaxy DB — Server Balance', () => {
    test('getServerBalance returns balance', () => {
        expect(galaxy.getServerBalance('default')).toBe(1000);
    });

    test('updateServerBalance modifies balance', () => {
        galaxy.updateServerBalance('default', 750);
        expect(galaxy.getServerBalance('default')).toBe(750);
    });

    test('getServerBalance returns 0 for unknown server', () => {
        expect(galaxy.getServerBalance('nonexistent')).toBe(0);
    });
});

// =============================================================================
// MEMBERS
// =============================================================================

describe('Galaxy DB — Members', () => {
    test('add members to server', () => {
        db.members.insert({ memberId: 'default_u-alice', serverId: 'default', userId: 'u-alice', role: 'owner', joinedAt: Date.now() });
        db.members.insert({ memberId: 'default_u-bob', serverId: 'default', userId: 'u-bob-longuuid-12345', role: 'member', joinedAt: Date.now() });

        const members = db.members.select().where({ serverId: 'default' }).all();
        expect(members.length).toBe(2);
    });

    test('getServerMembers enriches with user data', () => {
        const members = galaxy.getServerMembers('default');
        expect(members.length).toBe(2);

        const alice = members.find((m: any) => m.userId === 'u-alice');
        expect(alice).toBeDefined();
        expect(alice!.user).toBeDefined();
        expect(alice!.user!.username).toBe('Alice');
    });
});

// =============================================================================
// JOBS + GENERATIONS
// =============================================================================

describe('Galaxy DB — Jobs', () => {
    let jobId: string;

    test('create a job', () => {
        jobId = 'job-001';
        db.jobs.insert({
            jobId,
            serverId: 'default',
            instanceId: 'nano-banana',
            userId: 'u-alice',
            prompt: 'A cat wearing a top hat',
            status: 'pending',
            startedAt: Date.now(),
        });

        const job = db.jobs.select().where({ jobId }).get();
        expect(job).not.toBeNull();
        expect(job!.status).toBe('pending');
    });

    test('updateJobStatus transitions job', () => {
        galaxy.updateJobStatus('job-001', 'running');
        expect(db.jobs.select().where({ jobId: 'job-001' }).get()!.status).toBe('running');

        galaxy.updateJobStatus('job-001', 'completed', Date.now());
        const job = db.jobs.select().where({ jobId: 'job-001' }).get()!;
        expect(job.status).toBe('completed');
        expect(job.completedAt).toBeDefined();
    });

    test('add generations and update count', () => {
        // Add 3 generations
        for (let i = 0; i < 3; i++) {
            db.generations.insert({
                genId: `gen-${i}`,
                jobId: 'job-001',
                serverId: 'default',
                instanceId: 'nano-banana',
                userId: 'u-alice',
                prompt: 'A cat wearing a top hat',
                outputUrl: `https://cdn.example.com/gen-${i}.png`,
                createdAt: Date.now(),
            });
        }

        galaxy.updateJobGenerationCount('job-001');

        const job = db.jobs.select().where({ jobId: 'job-001' }).get()!;
        expect(job.generationCount).toBe(3);
        expect(job.lastGenerationAt).toBeDefined();
    });
});

// =============================================================================
// ENRICHMENT
// =============================================================================

describe('Galaxy DB — Enrichment', () => {
    test('enrichServerWithOwner adds owner user', () => {
        // Create system user so enrichment works
        galaxy.getOrCreateUser('system', 'System');

        const server = db.servers.select().where({ serverId: 'default' }).get()!;
        const enriched = galaxy.enrichServerWithOwner(server);
        expect(enriched.owner).toBeDefined();
        expect(enriched.owner!.username).toBe('System');
    });

    test('enrichJob adds user, instance, and template', () => {
        const job = db.jobs.select().where({ jobId: 'job-001' }).get()!;
        const enriched = galaxy.enrichJob(job);

        expect(enriched.user).toBeDefined();
        expect(enriched.user!.username).toBe('Alice');

        expect(enriched.instance).toBeDefined();
        expect(enriched.instance!.name).toBe('Nano Banana');

        expect(enriched.template).toBeDefined();
        expect(enriched.template!.name).toBe('Image Generator');
    });

    test('enrichGeneration adds user and instance', () => {
        const gen = db.generations.select().where({ genId: 'gen-0' }).get()!;
        const enriched = galaxy.enrichGeneration(gen);

        expect(enriched.user!.username).toBe('Alice');
        expect(enriched.instance!.name).toBe('Nano Banana');
    });
});

// =============================================================================
// MESSAGES
// =============================================================================

describe('Galaxy DB — Messages', () => {
    test('insert conversation messages', () => {
        const now = Date.now();
        db.messages.insert({ messageId: 'msg-1', agentInstanceId: 'nano-banana', userId: 'u-alice', role: 'user', content: 'Generate a sunset', createdAt: now });
        db.messages.insert({ messageId: 'msg-2', agentInstanceId: 'nano-banana', userId: 'u-alice', role: 'agent', content: 'Here is your sunset image', jobId: 'job-001', createdAt: now + 1000 });

        const thread = db.messages.select()
            .where({ agentInstanceId: 'nano-banana', userId: 'u-alice' })
            .orderBy('createdAt', 'asc')
            .all();

        expect(thread.length).toBe(2);
        expect(thread[0]!.role).toBe('user');
        expect(thread[1]!.role).toBe('agent');
    });
});

// =============================================================================
// CUSTOM AGENTS
// =============================================================================

describe('Galaxy DB — Custom Agents', () => {
    test('insert and query custom agent', () => {
        db.customAgents.insert({
            agentId: 'ca-001',
            serverId: 'default',
            userId: 'u-alice',
            name: 'My Custom Bot',
            code: 'export default { run() {} }',
            inputSchema: '{"type":"object"}',
            isPublic: true,
            price: 0,
            downloads: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        });

        const agent = db.customAgents.select().where({ agentId: 'ca-001' }).get();
        expect(agent).not.toBeNull();
        expect(agent!.name).toBe('My Custom Bot');

        // Query by server
        const serverAgents = db.customAgents.select().where({ serverId: 'default' }).all();
        expect(serverAgents.length).toBe(1);
    });
});

// =============================================================================
// FLUENT QUERIES
// =============================================================================

describe('Galaxy DB — Fluent Queries', () => {
    test('filter jobs by status', () => {
        const completed = db.jobs.select().where({ status: 'completed' }).all();
        expect(completed.length).toBeGreaterThan(0);
    });

    test('count generations per server', () => {
        const count = db.generations.select().where({ serverId: 'default' }).count();
        expect(count).toBe(3);
    });

    test('paginate templates', () => {
        const page1 = db.agentTemplates.select().orderBy('name', 'asc').limit(3).all();
        const page2 = db.agentTemplates.select().orderBy('name', 'asc').limit(3).offset(3).all();

        expect(page1.length).toBe(3);
        expect(page2.length).toBe(3);
        // No overlap
        const page1Names = page1.map((t: any) => t.name);
        const page2Names = page2.map((t: any) => t.name);
        expect(page1Names.every((n: string) => !page2Names.includes(n))).toBe(true);
    });

    test('find active instances for a server', () => {
        const active = db.agentInstances.select()
            .where({ serverId: 'default', isActive: true })
            .all();
        expect(active.length).toBe(2);
    });
});

// =============================================================================
// INDEXES
// =============================================================================

describe('Galaxy DB — Indexes', () => {
    test('all defined indexes exist', () => {
        const queryIndexes = (table: string) =>
            ((db as any).db
                .query(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='${table}'`)
                .all() as { name: string }[]).map(i => i.name);

        // Spot-check key indexes
        expect(queryIndexes('users')).toContain('idx_users_userId');
        expect(queryIndexes('servers')).toContain('idx_servers_serverId');
        expect(queryIndexes('servers')).toContain('idx_servers_slug');
        expect(queryIndexes('members')).toContain('idx_members_serverId_userId');
        expect(queryIndexes('agentTemplates')).toContain('idx_agentTemplates_templateId');
        expect(queryIndexes('agentInstances')).toContain('idx_agentInstances_serverId_templateId');
        expect(queryIndexes('jobs')).toContain('idx_jobs_jobId');
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
