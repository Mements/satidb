/**
 * system-db.test.ts — Tests for the Geeksy system database example
 *
 * Covers all 5 entity types: channels, memories, jobs, activities, config
 */

import { describe, test, expect } from 'bun:test';
import { createSystemDb } from './system-db';

const sys = createSystemDb(':memory:');

describe('System DB — Channels', () => {
    test('insert and find channel', () => {
        sys.channels.insert({
            channelId: 'tg-main',
            name: 'Main Telegram',
            type: 'telegram',
            status: 'connected',
            createdAt: Date.now(),
        });

        const ch = sys.channels.find('tg-main');
        expect(ch).not.toBeNull();
        expect(ch!.name).toBe('Main Telegram');
        expect(ch!.type).toBe('telegram');
    });

    test('findAll returns all channels', () => {
        sys.channels.insert({
            channelId: 'sse-dash',
            name: 'Dashboard SSE',
            type: 'sse',
            status: 'connected',
            createdAt: Date.now(),
        });

        expect(sys.channels.findAll().length).toBe(2);
    });

    test('update channel status', () => {
        const updated = sys.channels.update('tg-main', { status: 'disconnected' });
        expect(updated).not.toBeNull();

        const ch = sys.channels.find('tg-main');
        expect(ch!.status).toBe('disconnected');
    });

    test('update returns null for unknown channelId', () => {
        expect(sys.channels.update('nonexistent', { status: 'error' })).toBeNull();
    });

    test('delete channel', () => {
        sys.channels.delete('sse-dash');
        expect(sys.channels.find('sse-dash')).toBeNull();
        expect(sys.channels.findAll().length).toBe(1);
    });
});

describe('System DB — Jobs', () => {
    test('insert and find job', () => {
        sys.jobs.insert({
            jobId: 'j-001',
            name: 'scrape-data',
            spawnedBy: 'agent-alpha',
            status: 'running',
            startedAt: Date.now(),
        });

        const job = sys.jobs.find('j-001');
        expect(job).not.toBeNull();
        expect(job!.spawnedBy).toBe('agent-alpha');
    });

    test('findByAgent filters correctly', () => {
        sys.jobs.insert({
            jobId: 'j-002',
            name: 'summarize',
            spawnedBy: 'agent-beta',
            status: 'queued',
            startedAt: Date.now(),
        });
        sys.jobs.insert({
            jobId: 'j-003',
            name: 'deploy',
            spawnedBy: 'agent-alpha',
            status: 'completed',
            startedAt: Date.now(),
        });

        const alphaJobs = sys.jobs.findByAgent('agent-alpha');
        expect(alphaJobs.length).toBe(2);
        expect(alphaJobs.every((j: any) => j.spawnedBy === 'agent-alpha')).toBe(true);
    });

    test('update job status', () => {
        sys.jobs.update('j-001', { status: 'completed', completedAt: Date.now(), progress: 100 });

        const job = sys.jobs.find('j-001');
        expect(job!.status).toBe('completed');
        expect(job!.progress).toBe(100);
    });

    test('delete job', () => {
        sys.jobs.delete('j-002');
        expect(sys.jobs.find('j-002')).toBeNull();
    });
});

describe('System DB — Memories', () => {
    test('insert and find memory', () => {
        sys.memories.insert({
            memoryId: 'mem-001',
            name: 'User Preferences',
            dbPath: '/data/prefs.sqlite',
            description: 'Stores user preference data',
            createdAt: Date.now(),
        });

        const mem = sys.memories.find('mem-001');
        expect(mem).not.toBeNull();
        expect(mem!.name).toBe('User Preferences');
    });

    test('update memory', () => {
        sys.memories.update('mem-001', { sizeBytes: 4096, lastAccessed: Date.now() });

        const mem = sys.memories.find('mem-001');
        expect(mem!.sizeBytes).toBe(4096);
    });

    test('delete memory', () => {
        sys.memories.delete('mem-001');
        expect(sys.memories.find('mem-001')).toBeNull();
    });
});

describe('System DB — Activities', () => {
    test('insert activities', () => {
        for (let i = 0; i < 5; i++) {
            sys.activities.insert({
                activityId: `act-${i}`,
                source: 'system',
                sourceId: 'boot',
                type: 'info',
                message: `Boot step ${i}`,
                timestamp: Date.now() - (5 - i) * 1000,  // older → newer
            });
        }

        expect(sys.activities.findAll().length).toBe(5);
    });

    test('recent() returns newest first with limit', () => {
        const recent = sys.activities.recent(3);
        expect(recent.length).toBe(3);
        // Should be sorted desc
        expect(recent[0]!.timestamp).toBeGreaterThanOrEqual(recent[1]!.timestamp);
        expect(recent[1]!.timestamp).toBeGreaterThanOrEqual(recent[2]!.timestamp);
    });
});

describe('System DB — Config (key-value)', () => {
    test('set and get config', () => {
        sys.config.set('theme', 'dark');
        sys.config.set('language', 'en');

        expect(sys.config.get('theme')).toBe('dark');
        expect(sys.config.get('language')).toBe('en');
    });

    test('get returns null for missing key', () => {
        expect(sys.config.get('nonexistent')).toBeNull();
    });

    test('set overwrites existing key (upsert)', () => {
        sys.config.set('theme', 'light');
        expect(sys.config.get('theme')).toBe('light');
    });

    test('getAll returns all config as map', () => {
        const all = sys.config.getAll();
        expect(all.theme).toBe('light');
        expect(all.language).toBe('en');
    });
});

describe('System DB — Indexes', () => {
    test('indexes exist on all tables', () => {
        const query = (table: string) =>
            ((sys.db as any).db
                .query(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='${table}'`)
                .all() as { name: string }[]).map(i => i.name);

        expect(query('channels')).toContain('idx_channels_channelId');
        expect(query('channels')).toContain('idx_channels_type');
        expect(query('memories')).toContain('idx_memories_memoryId');
        expect(query('jobs')).toContain('idx_jobs_jobId');
        expect(query('jobs')).toContain('idx_jobs_spawnedBy');
        expect(query('jobs')).toContain('idx_jobs_status');
        expect(query('activities')).toContain('idx_activities_sourceId');
        expect(query('activities')).toContain('idx_activities_timestamp');
        expect(query('config')).toContain('idx_config_key');
    });
});

describe('System DB — Change Tracking', () => {
    test('mutations are tracked', () => {
        const changes = sys.db.getChangesSince(0);
        expect(changes.length).toBeGreaterThan(0);

        const inserts = changes.filter((c: any) => c.action === 'INSERT');
        const updates = changes.filter((c: any) => c.action === 'UPDATE');
        const deletes = changes.filter((c: any) => c.action === 'DELETE');

        expect(inserts.length).toBeGreaterThan(0);
        expect(updates.length).toBeGreaterThan(0);
        expect(deletes.length).toBeGreaterThan(0);
    });
});
