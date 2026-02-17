/**
 * system-db.ts — SatiDB example: Geeksy system database
 *
 * Phone-scoped: each phone number gets its own database.
 *
 * Stores: channels, activities, jobs, memories, config.
 *
 * Demonstrates:
 *  - Multiple entity schemas in one DB
 *  - Typed accessors wrapping select() queries
 *  - Lazy phone-scoped DB initialization
 *  - Upsert pattern for config key-value store
 */

import { SatiDB, z } from '../src/satidb';

// =============================================================================
// SCHEMAS  (no `id` — SatiDB adds it automatically)
// =============================================================================

const channelSchema = z.object({
    channelId: z.string(),
    name: z.string(),
    type: z.enum(['telegram', 'sse']),
    status: z.enum(['connected', 'disconnected', 'error']),
    config: z.string().optional(),        // JSON blob, defaults to "{}"
    messagesIn: z.number().optional(),
    messagesOut: z.number().optional(),
    lastActivity: z.number().optional(),
    createdAt: z.number(),
});

const memorySchema = z.object({
    memoryId: z.string(),
    name: z.string(),
    dbPath: z.string(),
    description: z.string().optional(),
    tables: z.string().optional(),        // JSON array
    sizeBytes: z.number().optional(),
    lastAccessed: z.number().optional(),
    accessedBy: z.string().optional(),    // JSON array
    channelId: z.string().optional(),
    createdAt: z.number(),
});

const jobSchema = z.object({
    jobId: z.string(),
    name: z.string(),
    spawnedBy: z.string(),
    status: z.enum(['running', 'completed', 'failed', 'stopped', 'queued']),
    pid: z.number().optional(),
    script: z.string().optional(),
    input: z.string().optional(),         // JSON
    output: z.string().optional(),
    progress: z.number().optional(),
    startedAt: z.number(),
    completedAt: z.number().optional(),
    duration: z.number().optional(),
});

const activitySchema = z.object({
    activityId: z.string(),
    source: z.enum(['agent', 'job', 'memory', 'channel', 'system']),
    sourceId: z.string(),
    type: z.enum(['info', 'warning', 'error', 'success']),
    message: z.string(),
    timestamp: z.number(),
});

const configSchema = z.object({
    key: z.string(),
    value: z.string(),
});

const schemas = {
    channels: channelSchema,
    memories: memorySchema,
    jobs: jobSchema,
    activities: activitySchema,
    config: configSchema,
};

// =============================================================================
// PHONE-SCOPED LAZY DB
// =============================================================================

let _phone: string | null = null;
let _db: ReturnType<typeof createDb> | null = null;

function createDb(dbPath: string) {
    return new SatiDB(dbPath, schemas, {
        changeTracking: true,
        indexes: {
            channels: ['channelId', 'type'],
            memories: ['memoryId'],
            jobs: ['jobId', 'spawnedBy', 'status'],
            activities: ['sourceId', 'timestamp'],
            config: ['key'],
        },
    });
}

function getDb() {
    if (!_db) {
        const dbPath = _phone
            ? `${_phone.replace(/[^0-9]/g, '')}_system.db`
            : 'system.db';
        _db = createDb(dbPath);
    }
    return _db;
}

/** Switch to a phone-scoped DB. Call when auth succeeds. */
export function setActivePhone(phone: string | null) {
    const oldDigits = _phone?.replace(/[^0-9]/g, '') || '';
    const newDigits = phone?.replace(/[^0-9]/g, '') || '';
    if (oldDigits !== newDigits) {
        _phone = phone;
        _db = null;
    }
}

export function getActivePhone(): string | null {
    return _phone;
}

// =============================================================================
// TYPED ACCESSORS  — all queries use select()
// =============================================================================

export const channels = {
    findAll: () =>
        getDb().channels.select().all(),

    find: (channelId: string) =>
        getDb().channels.select().where({ channelId }).get(),

    insert: (data: { channelId?: string; name: string; type: 'telegram' | 'sse'; status: 'connected' | 'disconnected' | 'error'; config?: string; createdAt: number }) =>
        getDb().channels.insert({ ...data, channelId: data.channelId || crypto.randomUUID() }),

    update: (channelId: string, data: Record<string, any>) => {
        const existing = getDb().channels.select().where({ channelId }).get();
        if (existing) return getDb().channels.update(existing.id, data);
        return null;
    },

    delete: (channelId: string) => {
        const existing = getDb().channels.select().where({ channelId }).get();
        if (existing) getDb().channels.delete(existing.id);
    },
};

export const memories = {
    findAll: () =>
        getDb().memories.select().all(),

    find: (memoryId: string) =>
        getDb().memories.select().where({ memoryId }).get(),

    insert: (data: { memoryId?: string; name: string; dbPath: string; description?: string; createdAt: number }) =>
        getDb().memories.insert({ ...data, memoryId: data.memoryId || crypto.randomUUID() }),

    update: (memoryId: string, data: Record<string, any>) => {
        const existing = getDb().memories.select().where({ memoryId }).get();
        if (existing) return getDb().memories.update(existing.id, data);
        return null;
    },

    delete: (memoryId: string) => {
        const existing = getDb().memories.select().where({ memoryId }).get();
        if (existing) getDb().memories.delete(existing.id);
    },
};

export const jobs = {
    findAll: () =>
        getDb().jobs.select().all(),

    find: (jobId: string) =>
        getDb().jobs.select().where({ jobId }).get(),

    findByAgent: (agentId: string) =>
        getDb().jobs.select().where({ spawnedBy: agentId }).all(),

    insert: (data: { jobId?: string; name: string; spawnedBy: string; status: 'running' | 'completed' | 'failed' | 'stopped' | 'queued'; startedAt: number; script?: string }) =>
        getDb().jobs.insert({ ...data, jobId: data.jobId || crypto.randomUUID() }),

    update: (jobId: string, data: Record<string, any>) => {
        const existing = getDb().jobs.select().where({ jobId }).get();
        if (existing) return getDb().jobs.update(existing.id, data);
        return null;
    },

    delete: (jobId: string) => {
        const existing = getDb().jobs.select().where({ jobId }).get();
        if (existing) getDb().jobs.delete(existing.id);
    },
};

export const activities = {
    findAll: () =>
        getDb().activities.select().all(),

    recent: (limit = 50) =>
        getDb().activities.select()
            .orderBy('timestamp', 'desc')
            .limit(limit)
            .all(),

    insert: (data: { activityId?: string; source: 'agent' | 'job' | 'memory' | 'channel' | 'system'; sourceId: string; type: 'info' | 'warning' | 'error' | 'success'; message: string; timestamp: number }) =>
        getDb().activities.insert({ ...data, activityId: data.activityId || crypto.randomUUID() }),
};

export const config = {
    get: (key: string): string | null => {
        const row = getDb().config.select().where({ key }).get();
        return row ? row.value : null;
    },

    set: (key: string, value: string) => {
        getDb().config.upsert({ key }, { key, value });
    },

    getAll: (): Record<string, string> => {
        const rows = getDb().config.select().all();
        const result: Record<string, string> = {};
        for (const row of rows) result[row.key] = row.value;
        return result;
    },
};

// =============================================================================
// FACTORY — for testing with in-memory DBs
// =============================================================================

export function createSystemDb(dbPath: string) {
    const db = createDb(dbPath);

    // Local closures over `db` instead of the lazy singleton
    return {
        db,
        channels: {
            findAll: () => db.channels.select().all(),
            find: (channelId: string) => db.channels.select().where({ channelId }).get(),
            insert: (data: any) => db.channels.insert({ ...data, channelId: data.channelId || crypto.randomUUID() }),
            update: (channelId: string, data: any) => {
                const existing = db.channels.select().where({ channelId }).get();
                if (existing) return db.channels.update(existing.id, data);
                return null;
            },
            delete: (channelId: string) => {
                const existing = db.channels.select().where({ channelId }).get();
                if (existing) db.channels.delete(existing.id);
            },
        },
        memories: {
            findAll: () => db.memories.select().all(),
            find: (memoryId: string) => db.memories.select().where({ memoryId }).get(),
            insert: (data: any) => db.memories.insert({ ...data, memoryId: data.memoryId || crypto.randomUUID() }),
            update: (memoryId: string, data: any) => {
                const existing = db.memories.select().where({ memoryId }).get();
                if (existing) return db.memories.update(existing.id, data);
                return null;
            },
            delete: (memoryId: string) => {
                const existing = db.memories.select().where({ memoryId }).get();
                if (existing) db.memories.delete(existing.id);
            },
        },
        jobs: {
            findAll: () => db.jobs.select().all(),
            find: (jobId: string) => db.jobs.select().where({ jobId }).get(),
            findByAgent: (agentId: string) => db.jobs.select().where({ spawnedBy: agentId }).all(),
            insert: (data: any) => db.jobs.insert({ ...data, jobId: data.jobId || crypto.randomUUID() }),
            update: (jobId: string, data: any) => {
                const existing = db.jobs.select().where({ jobId }).get();
                if (existing) return db.jobs.update(existing.id, data);
                return null;
            },
            delete: (jobId: string) => {
                const existing = db.jobs.select().where({ jobId }).get();
                if (existing) db.jobs.delete(existing.id);
            },
        },
        activities: {
            findAll: () => db.activities.select().all(),
            recent: (limit = 50) => db.activities.select().orderBy('timestamp', 'desc').limit(limit).all(),
            insert: (data: any) => db.activities.insert({ ...data, activityId: data.activityId || crypto.randomUUID() }),
        },
        config: {
            get: (key: string): string | null => {
                const row = db.config.select().where({ key }).get();
                return row ? row.value : null;
            },
            set: (key: string, value: string) => {
                db.config.upsert({ key }, { key, value });
            },
            getAll: (): Record<string, string> => {
                const rows = db.config.select().all();
                const result: Record<string, string> = {};
                for (const row of rows) result[row.key] = row.value;
                return result;
            },
        },
    };
}
