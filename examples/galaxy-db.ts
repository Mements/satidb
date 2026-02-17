/**
 * galaxy-db.ts — SatiDB example: Galaxy AI platform database
 *
 * Architecture:
 * - Users: Platform users
 * - Servers: Spaces where agents are deployed
 * - Members: Server membership (user + role) — (many-to-many junction)
 * - AgentTemplates: Base agent types (image-generator, weather-visualizer etc.)
 * - AgentInstances: Deployed agents on a server with specific config
 * - Jobs: User invocations of agent instances
 * - Generations: Outputs produced by jobs (images, markdown)
 * - CustomAgents: User-generated agents with SDK code
 * - Messages: Conversations between users and agent instances
 *
 * Demonstrates:
 *  - 9 entity schemas with z.lazy() relationships
 *  - Belongs-to and one-to-many via auto-generated integer foreign keys
 *  - Fluent select() and update().where().exec() queries
 *  - Relationship navigation (entity.children.push(), entity.parent())
 *  - Complex indexes (single + composite)
 *  - Upsert-based seeding
 *  - No raw SQL — everything through SatiDB
 */

import { SatiDB, z } from '../src/satidb';

// =============================================================================
// TYPE INTERFACES (break circular z.lazy inference)
// =============================================================================

interface User {
    username: string;
    avatarUrl?: string;
    walletAddress?: string;
    createdAt: number;
    ownedServers?: Server[];
    members?: Member[];
    createdInstances?: AgentInstance[];
    jobs?: Job[];
    generations?: Generation[];
    customAgents?: CustomAgent[];
    messages?: Message[];
}

interface Server {
    name: string;
    slug: string;
    description?: string;
    icon?: string;
    color?: string;
    owner?: User;
    inviteCode: string;
    isPublic?: boolean;
    balance?: number;
    createdAt: number;
    members?: Member[];
    agentInstances?: AgentInstance[];
    customAgents?: CustomAgent[];
}

interface Member {
    role: 'owner' | 'admin' | 'member';
    joinedAt: number;
    server?: Server;
    user?: User;
}

interface AgentTemplate {
    name: string;
    description: string;
    icon?: string;
    color?: string;
    outputType?: 'image' | 'text';
    isRecurring?: boolean;
    repoUrl?: string;
    entryPoint?: string;
    isExternal?: boolean;
    isPublic?: boolean;
    createdAt: number;
    agentInstances?: AgentInstance[];
}

interface AgentInstance {
    name: string;
    description?: string;
    config?: string;
    icon?: string;
    color?: string;
    isActive?: boolean;
    createdAt: number;
    server?: Server;
    template?: AgentTemplate;
    createdByUser?: User;
    jobs?: Job[];
    generations?: Generation[];
    messages?: Message[];
}

interface Job {
    prompt: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
    processId?: string;
    generationCount?: number;
    lastGenerationAt?: number;
    startedAt: number;
    completedAt?: number;
    errorMessage?: string;
    user?: User;
    instance?: AgentInstance;
    generations?: Generation[];
    messages?: Message[];
}

interface Generation {
    prompt: string;
    finalPrompt?: string;
    outputUrl?: string;
    outputText?: string;
    trendingScore?: number;
    isPrivate?: boolean;
    createdAt: number;
    job?: Job;
    user?: User;
    instance?: AgentInstance;
}

interface CustomAgent {
    name: string;
    description?: string;
    code: string;
    inputSchema: string;
    isPublic?: boolean;
    price?: number;
    downloads?: number;
    authorName?: string;
    createdAt: number;
    updatedAt: number;
    server?: Server;
    user?: User;
}

interface Message {
    role: 'user' | 'agent';
    content: string;
    isPrivate?: boolean;
    createdAt: number;
    agentInstance?: AgentInstance;
    user?: User;
    job?: Job;
}

// =============================================================================
// SCHEMAS — with z.lazy() relationships
// =============================================================================

const UserSchema: z.ZodType<User> = z.object({
    username: z.string(),
    avatarUrl: z.string().optional(),
    walletAddress: z.string().optional(),
    createdAt: z.number(),
    // one-to-many
    ownedServers: z.lazy(() => z.array(ServerSchema)).optional(),
    members: z.lazy(() => z.array(MemberSchema)).optional(),
    createdInstances: z.lazy(() => z.array(AgentInstanceSchema)).optional(),
    jobs: z.lazy(() => z.array(JobSchema)).optional(),
    generations: z.lazy(() => z.array(GenerationSchema)).optional(),
    customAgents: z.lazy(() => z.array(CustomAgentSchema)).optional(),
    messages: z.lazy(() => z.array(MessageSchema)).optional(),
});

const ServerSchema: z.ZodType<Server> = z.object({
    name: z.string(),
    slug: z.string(),
    description: z.string().optional(),
    icon: z.string().optional(),
    color: z.string().optional(),
    owner: z.lazy(() => UserSchema).optional(),               // belongs-to User → ownerId
    inviteCode: z.string(),
    isPublic: z.boolean().optional(),
    balance: z.number().optional(),
    createdAt: z.number(),
    // one-to-many
    members: z.lazy(() => z.array(MemberSchema)).optional(),
    agentInstances: z.lazy(() => z.array(AgentInstanceSchema)).optional(),
    customAgents: z.lazy(() => z.array(CustomAgentSchema)).optional(),
});

const MemberSchema: z.ZodType<Member> = z.object({
    role: z.enum(['owner', 'admin', 'member']),
    joinedAt: z.number(),
    // belongs-to (many-to-many junction: User ↔ Server)
    server: z.lazy(() => ServerSchema).optional(),            // → serverId
    user: z.lazy(() => UserSchema).optional(),                // → userId
});

const AgentTemplateSchema: z.ZodType<AgentTemplate> = z.object({
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
    createdAt: z.number(),
    // one-to-many
    agentInstances: z.lazy(() => z.array(AgentInstanceSchema)).optional(),
});

const AgentInstanceSchema: z.ZodType<AgentInstance> = z.object({
    name: z.string(),
    description: z.string().optional(),
    config: z.string().optional(),
    icon: z.string().optional(),
    color: z.string().optional(),
    isActive: z.boolean().optional(),
    createdAt: z.number(),
    // belongs-to
    server: z.lazy(() => ServerSchema).optional(),           // → serverId
    template: z.lazy(() => AgentTemplateSchema).optional(),  // → templateId
    createdByUser: z.lazy(() => UserSchema).optional(),      // → createdByUserId
    // one-to-many
    jobs: z.lazy(() => z.array(JobSchema)).optional(),
    generations: z.lazy(() => z.array(GenerationSchema)).optional(),
    messages: z.lazy(() => z.array(MessageSchema)).optional(),
});

const JobSchema: z.ZodType<Job> = z.object({
    prompt: z.string(),
    status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']),
    processId: z.string().optional(),
    generationCount: z.number().optional(),
    lastGenerationAt: z.number().optional(),
    startedAt: z.number(),
    completedAt: z.number().optional(),
    errorMessage: z.string().optional(),
    // belongs-to
    user: z.lazy(() => UserSchema).optional(),               // → userId
    instance: z.lazy(() => AgentInstanceSchema).optional(),   // → instanceId
    // one-to-many
    generations: z.lazy(() => z.array(GenerationSchema)).optional(),
    messages: z.lazy(() => z.array(MessageSchema)).optional(),
});

const GenerationSchema: z.ZodType<Generation> = z.object({
    prompt: z.string(),
    finalPrompt: z.string().optional(),
    outputUrl: z.string().optional(),
    outputText: z.string().optional(),
    trendingScore: z.number().optional(),
    isPrivate: z.boolean().optional(),
    createdAt: z.number(),
    // belongs-to
    job: z.lazy(() => JobSchema).optional(),                  // → jobId
    user: z.lazy(() => UserSchema).optional(),                // → userId
    instance: z.lazy(() => AgentInstanceSchema).optional(),   // → instanceId
});

const CustomAgentSchema: z.ZodType<CustomAgent> = z.object({
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
    // belongs-to
    server: z.lazy(() => ServerSchema).optional(),            // → serverId
    user: z.lazy(() => UserSchema).optional(),                // → userId
});

const MessageSchema: z.ZodType<Message> = z.object({
    role: z.enum(['user', 'agent']),
    content: z.string(),
    isPrivate: z.boolean().optional(),
    createdAt: z.number(),
    // belongs-to
    agentInstance: z.lazy(() => AgentInstanceSchema).optional(), // → agentInstanceId
    user: z.lazy(() => UserSchema).optional(),                   // → userId
    job: z.lazy(() => JobSchema).optional(),                      // → jobId
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
            users: ['username'],
            servers: ['slug', 'ownerId'],
            members: ['serverId', 'userId', ['serverId', 'userId']],
            agentTemplates: ['name'],
            agentInstances: ['serverId', 'templateId', ['serverId', 'templateId']],
            jobs: ['userId', 'instanceId', 'status'],
            generations: ['jobId', 'instanceId', 'userId'],
            customAgents: ['serverId', 'userId'],
            messages: ['agentInstanceId', 'userId', ['agentInstanceId', 'userId']],
        },
    });

    // =========================================================================
    // BALANCE HELPERS
    // =========================================================================

    function getServerBalance(serverId: number): number {
        const server = db.servers.select().where({ id: serverId } as any).get();
        return (server as any)?.balance ?? 0;
    }

    function updateServerBalance(serverId: number, newBalance: number) {
        db.servers.update(serverId, { balance: newBalance } as any);
    }

    // =========================================================================
    // JOB HELPERS
    // =========================================================================

    function updateJobStatus(jobId: number, status: string, completedAt?: number) {
        const data: Record<string, any> = { status };
        if (completedAt) data.completedAt = completedAt;
        db.jobs.update(jobId, data);
    }

    function updateJobGenerationCount(jobId: number) {
        const count = db.generations.select().where({ jobId } as any).count();
        db.jobs.update(jobId, {
            generationCount: count,
            lastGenerationAt: Date.now(),
        } as any);
    }

    // =========================================================================
    // RELATIONSHIP ENRICHMENT — uses z.lazy() navigation
    // =========================================================================

    function enrichServerWithOwner(server: any) {
        const owner = server.owner?.();
        return { ...server, owner: owner || undefined };
    }

    function enrichJob(job: any) {
        const user = job.user?.();
        const instance = job.instance?.();
        const template = instance?.template?.();
        return {
            ...job,
            user: user || undefined,
            instance: instance || undefined,
            template: template || undefined,
        };
    }

    function enrichGeneration(gen: any) {
        const user = gen.user?.();
        const instance = gen.instance?.();
        return { ...gen, user: user || undefined, instance: instance || undefined };
    }

    function getServerMembers(serverId: number) {
        const server = db.servers.get(serverId);
        if (!server) return [];
        const members = (server as any).members.find();
        return members.map((m: any) => {
            const user = m.user?.();
            return { ...m, user: user || undefined };
        });
    }

    function getOrCreateUser(username: string) {
        const existing = db.users.select().where({ username }).get();
        if (existing) return existing;

        return db.users.insert({
            username,
            createdAt: Date.now(),
        });
    }

    // =========================================================================
    // SEED DEFAULTS
    // =========================================================================

    function seedDefaultTemplates() {
        const templates = [
            { name: 'Image Generator', description: 'Generate images from text prompts using AI', icon: 'image', color: 'oklch(0.72 0.17 110)', outputType: 'image' as const, isRecurring: false },
            { name: 'Logo Generator', description: 'Create professional logos from descriptions', icon: 'palette', color: 'oklch(0.68 0.16 40)', outputType: 'image' as const, isRecurring: false },
            { name: 'Weather Visualizer', description: 'Generate 3D city scenes based on live weather data', icon: 'cloud-sun', color: 'oklch(0.7 0.15 220)', outputType: 'image' as const, isRecurring: true },
            { name: 'Markdown Report', description: 'Generate structured markdown reports and documents', icon: 'file-text', color: 'oklch(0.7 0.16 200)', outputType: 'text' as const, isRecurring: false },
            { name: 'Trading Agent', description: 'Automated trading based on signals with real-time logs', icon: 'trending-up', color: 'oklch(0.65 0.18 145)', outputType: 'text' as const, isRecurring: true },
            { name: 'Placeholder Image', description: 'Generate placeholder images with text', icon: 'image-off', color: 'oklch(0.6 0.14 250)', outputType: 'image' as const, isRecurring: true },
            { name: 'Streaming Agent', description: 'External agent process with real-time generation streaming', icon: 'zap', color: 'oklch(0.75 0.18 60)', outputType: 'image' as const, isRecurring: true, isExternal: true, entryPoint: 'streaming-image-agent.ts' },
            { name: 'Unsplash Stream', description: 'Streams random Unsplash images based on your prompt', icon: '📸', color: 'oklch(0.65 0.20 280)', outputType: 'image' as const, isRecurring: true, isExternal: true, entryPoint: 'unsplash-streaming-agent.ts' },
            { name: 'OpenClaw', description: 'Personal AI assistant with local-first architecture', icon: '🦀', color: 'oklch(0.70 0.18 25)', outputType: 'text' as const, isRecurring: false },
        ];

        for (const t of templates) {
            db.agentTemplates.upsert(
                { name: t.name },
                { ...t, createdAt: Date.now() },
            );
        }
    }

    function seedDefaultServer(systemUser: any) {
        // Create default server (owned by system user)
        const server = db.servers.upsert(
            { slug: 'galaxy' },
            {
                name: 'Galaxy',
                slug: 'galaxy',
                description: 'The default Galaxy AI community',
                color: 'oklch(0.7 0.17 280)',
                icon: '🌌',
                ownerId: systemUser.id,
                inviteCode: 'GALAXY',
                isPublic: true,
                balance: 1000,
                createdAt: Date.now(),
            } as any,
        );

        // Seed templates
        seedDefaultTemplates();

        // Deploy default agent instances
        const imageGenTemplate = db.agentTemplates.select().where({ name: 'Image Generator' }).get()!;
        const placeholderTemplate = db.agentTemplates.select().where({ name: 'Placeholder Image' }).get()!;

        const defaultInstances = [
            { name: 'Nano Banana', description: 'Fast AI image generation powered by Flux', icon: '🍌', color: '#facc15', serverId: server.id, templateId: imageGenTemplate.id, createdByUserId: systemUser.id },
            { name: 'GPT Image', description: 'Generate images with GPT-powered AI', icon: '🎨', color: '#10b981', serverId: server.id, templateId: placeholderTemplate.id, createdByUserId: systemUser.id },
        ];

        for (const inst of defaultInstances) {
            db.agentInstances.upsert(
                { name: inst.name },
                { ...inst, config: '{}', isActive: true, createdAt: Date.now() } as any,
            );
        }

        return server;
    }

    return {
        db,

        // Balance
        getServerBalance,
        updateServerBalance,

        // Jobs
        updateJobStatus,
        updateJobGenerationCount,

        // Enrichment (uses relationship navigation)
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
