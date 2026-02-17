/**
 * galaxy-db.ts — SatiDB example: Galaxy AI platform database
 *
 * Architecture:
 * - Users: Platform users
 * - Servers: Spaces where agents are deployed
 * - Members: Server membership (user + role)
 * - AgentTemplates: Base agent types (image-generator, weather-visualizer etc.)
 * - AgentInstances: Deployed agents on a server with specific config
 * - Jobs: User invocations of agent instances
 * - Generations: Outputs produced by jobs (images, markdown)
 * - CustomAgents: User-generated agents with SDK code
 * - Messages: Conversations between users and agent instances
 *
 * Demonstrates:
 *  - 9 entity schemas in a single DB
 *  - Complex indexes (single + composite)
 *  - Relationship enrichment using select()
 *  - Upsert-based seeding
 *  - No raw SQL — everything through SatiDB
 */

import { SatiDB, z } from '../src/satidb';

// =============================================================================
// SCHEMAS
// =============================================================================

const UserSchema = z.object({
    userId: z.string(),
    username: z.string(),
    avatarUrl: z.string().optional(),
    walletAddress: z.string().optional(),
    createdAt: z.number(),
});

const ServerSchema = z.object({
    serverId: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string().optional(),
    icon: z.string().optional(),
    color: z.string().optional(),
    ownerId: z.string(),
    inviteCode: z.string(),
    isPublic: z.boolean().optional(),
    balance: z.number().optional(),
    createdAt: z.number(),
});

const MemberSchema = z.object({
    memberId: z.string(),
    serverId: z.string(),
    userId: z.string(),
    role: z.enum(['owner', 'admin', 'member']),
    joinedAt: z.number(),
});

const AgentTemplateSchema = z.object({
    templateId: z.string(),
    name: z.string(),
    description: z.string(),
    icon: z.string().optional(),
    color: z.string().optional(),
    outputType: z.enum(['image', 'text']).optional(),
    isRecurring: z.boolean().optional(),
    repoUrl: z.string().optional(),
    entryPoint: z.string().optional(),
    isExternal: z.boolean().optional(),
    isPublic: z.boolean().optional(),
    authorId: z.string().optional(),
    createdAt: z.number(),
});

const AgentInstanceSchema = z.object({
    instanceId: z.string(),
    serverId: z.string(),
    templateId: z.string(),
    name: z.string(),
    description: z.string().optional(),
    config: z.string().optional(),
    icon: z.string().optional(),
    color: z.string().optional(),
    isActive: z.boolean().optional(),
    createdBy: z.string(),
    createdAt: z.number(),
});

const JobSchema = z.object({
    jobId: z.string(),
    serverId: z.string(),
    instanceId: z.string(),
    userId: z.string(),
    prompt: z.string(),
    status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']),
    processId: z.string().optional(),
    generationCount: z.number().optional(),
    lastGenerationAt: z.number().optional(),
    startedAt: z.number(),
    completedAt: z.number().optional(),
    errorMessage: z.string().optional(),
});

const GenerationSchema = z.object({
    genId: z.string(),
    jobId: z.string(),
    serverId: z.string(),
    instanceId: z.string(),
    userId: z.string(),
    prompt: z.string(),
    finalPrompt: z.string().optional(),
    outputUrl: z.string().optional(),
    outputText: z.string().optional(),
    trendingScore: z.number().optional(),
    isPrivate: z.boolean().optional(),
    createdAt: z.number(),
});

const CustomAgentSchema = z.object({
    agentId: z.string(),
    serverId: z.string(),
    userId: z.string(),
    name: z.string(),
    description: z.string().optional(),
    code: z.string(),
    inputSchema: z.string(),
    isPublic: z.boolean().optional(),
    price: z.number().optional(),
    downloads: z.number().optional(),
    authorName: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
});

const MessageSchema = z.object({
    messageId: z.string(),
    agentInstanceId: z.string(),
    userId: z.string(),
    role: z.enum(['user', 'agent']),
    content: z.string(),
    jobId: z.string().optional(),
    isPrivate: z.boolean().optional(),
    createdAt: z.number(),
});

const schemas = {
    users: UserSchema,
    servers: ServerSchema,
    members: MemberSchema,
    agentTemplates: AgentTemplateSchema,
    agentInstances: AgentInstanceSchema,
    jobs: JobSchema,
    generations: GenerationSchema,
    customAgents: CustomAgentSchema,
    messages: MessageSchema,
};

// =============================================================================
// DB FACTORY
// =============================================================================

export function createGalaxyDb(dbPath: string) {
    const db = new SatiDB(dbPath, schemas, {
        changeTracking: true,
        indexes: {
            users: ['userId'],
            servers: ['serverId', 'slug', 'ownerId'],
            members: ['serverId', 'userId', ['serverId', 'userId']],
            agentTemplates: ['templateId'],
            agentInstances: ['instanceId', 'serverId', 'templateId', ['serverId', 'templateId']],
            jobs: ['jobId', 'serverId', 'instanceId', 'userId', 'status'],
            generations: ['genId', 'jobId', 'serverId', 'instanceId', 'userId'],
            customAgents: ['agentId', 'serverId', 'userId'],
            messages: ['agentInstanceId', 'userId', ['agentInstanceId', 'userId']],
        },
    });

    // =========================================================================
    // BALANCE HELPERS — no raw SQL needed
    // =========================================================================

    function getServerBalance(serverId: string): number {
        const server = db.servers.select().where({ serverId }).get();
        return server?.balance ?? 0;
    }

    function updateServerBalance(serverId: string, newBalance: number) {
        const server = db.servers.select().where({ serverId }).get();
        if (server) db.servers.update(server.id, { balance: newBalance });
    }

    // =========================================================================
    // JOB HELPERS
    // =========================================================================

    function updateJobStatus(jobId: string, status: string, completedAt?: number) {
        const job = db.jobs.select().where({ jobId }).get();
        if (job) {
            const data: Record<string, any> = { status };
            if (completedAt) data.completedAt = completedAt;
            db.jobs.update(job.id, data);
        }
    }

    function updateJobGenerationCount(jobId: string) {
        const job = db.jobs.select().where({ jobId }).get();
        if (!job) return;
        const count = db.generations.select().where({ jobId }).count();
        db.jobs.update(job.id, {
            generationCount: count,
            lastGenerationAt: Date.now(),
        });
    }

    // =========================================================================
    // RELATIONSHIP ENRICHMENT  — synchronous, no Promise.all needed
    // =========================================================================

    function enrichServerWithOwner(server: any) {
        const owner = db.users.select().where({ userId: server.ownerId }).get();
        return { ...server, owner: owner || undefined };
    }

    function enrichJob(job: any) {
        const user = db.users.select().where({ userId: job.userId }).get();
        const instance = db.agentInstances.select().where({ instanceId: job.instanceId }).get();
        const template = instance
            ? db.agentTemplates.select().where({ templateId: instance.templateId }).get()
            : null;
        return {
            ...job,
            user: user || undefined,
            instance: instance || undefined,
            template: template || undefined,
        };
    }

    function enrichGeneration(gen: any) {
        const user = db.users.select().where({ userId: gen.userId }).get();
        const instance = db.agentInstances.select().where({ instanceId: gen.instanceId }).get();
        return { ...gen, user: user || undefined, instance: instance || undefined };
    }

    function getServerMembers(serverId: string) {
        const members = db.members.select().where({ serverId }).all();
        return members.map((m: any) => {
            const user = db.users.select().where({ userId: m.userId }).get();
            return { ...m, user: user || undefined };
        });
    }

    function getOrCreateUser(userId: string, username?: string) {
        const existing = db.users.select().where({ userId }).get();
        if (existing) return existing;

        return db.users.insert({
            userId,
            username: username || `user_${userId.slice(0, 8)}`,
            createdAt: Date.now(),
        });
    }

    // =========================================================================
    // SEED DEFAULTS
    // =========================================================================

    function seedDefaultTemplates() {
        const templates = [
            { templateId: 'image-generator', name: 'Image Generator', description: 'Generate images from text prompts using AI', icon: 'image', color: 'oklch(0.72 0.17 110)', outputType: 'image' as const, isRecurring: false },
            { templateId: 'logo-generator', name: 'Logo Generator', description: 'Create professional logos from descriptions', icon: 'palette', color: 'oklch(0.68 0.16 40)', outputType: 'image' as const, isRecurring: false },
            { templateId: 'weather-visualizer', name: 'Weather Visualizer', description: 'Generate 3D city scenes based on live weather data', icon: 'cloud-sun', color: 'oklch(0.7 0.15 220)', outputType: 'image' as const, isRecurring: true },
            { templateId: 'markdown-report', name: 'Markdown Report', description: 'Generate structured markdown reports and documents', icon: 'file-text', color: 'oklch(0.7 0.16 200)', outputType: 'text' as const, isRecurring: false },
            { templateId: 'trading-agent', name: 'Trading Agent', description: 'Automated trading based on signals with real-time logs', icon: 'trending-up', color: 'oklch(0.65 0.18 145)', outputType: 'text' as const, isRecurring: true },
            { templateId: 'placeholder-image', name: 'Placeholder Image', description: 'Generate placeholder images with text', icon: 'image-off', color: 'oklch(0.6 0.14 250)', outputType: 'image' as const, isRecurring: true },
            { templateId: 'streaming-agent', name: 'Streaming Agent', description: 'External agent process with real-time generation streaming', icon: 'zap', color: 'oklch(0.75 0.18 60)', outputType: 'image' as const, isRecurring: true, isExternal: true, entryPoint: 'streaming-image-agent.ts' },
            { templateId: 'unsplash-streaming', name: 'Unsplash Stream', description: 'Streams random Unsplash images based on your prompt', icon: '📸', color: 'oklch(0.65 0.20 280)', outputType: 'image' as const, isRecurring: true, isExternal: true, entryPoint: 'unsplash-streaming-agent.ts' },
            { templateId: 'openclaw', name: 'OpenClaw', description: 'Personal AI assistant with local-first architecture', icon: '🦀', color: 'oklch(0.70 0.18 25)', outputType: 'text' as const, isRecurring: false },
        ];

        for (const t of templates) {
            db.agentTemplates.upsert(
                { templateId: t.templateId },
                { ...t, createdAt: Date.now() },
            );
        }
    }

    function seedDefaultServer() {
        // Create default server
        db.servers.upsert(
            { serverId: 'default' },
            {
                serverId: 'default',
                name: 'Galaxy',
                slug: 'galaxy',
                description: 'The default Galaxy AI community',
                color: 'oklch(0.7 0.17 280)',
                icon: '🌌',
                ownerId: 'system',
                inviteCode: 'GALAXY',
                isPublic: true,
                balance: 1000,
                createdAt: Date.now(),
            },
        );

        // Seed templates
        seedDefaultTemplates();

        // Deploy default agent instances
        const defaultInstances = [
            { instanceId: 'nano-banana', serverId: 'default', templateId: 'image-generator', name: 'Nano Banana', description: 'Fast AI image generation powered by Flux', icon: '🍌', color: '#facc15', createdBy: 'system' },
            { instanceId: 'gpt-image', serverId: 'default', templateId: 'placeholder-image', name: 'GPT Image', description: 'Generate images with GPT-powered AI', icon: '🎨', color: '#10b981', createdBy: 'system' },
        ];

        for (const inst of defaultInstances) {
            db.agentInstances.upsert(
                { instanceId: inst.instanceId },
                { ...inst, config: '{}', isActive: true, createdAt: Date.now() },
            );
        }
    }

    return {
        db,

        // Balance
        getServerBalance,
        updateServerBalance,

        // Jobs
        updateJobStatus,
        updateJobGenerationCount,

        // Enrichment
        enrichServerWithOwner,
        enrichJob,
        enrichGeneration,
        getServerMembers,
        getOrCreateUser,

        // Seeding
        seedDefaultTemplates,
        seedDefaultServer,
    };
}
