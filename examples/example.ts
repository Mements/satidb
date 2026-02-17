/**
 * example.ts — Complete sqlite-zod-orm demo
 *
 * Demonstrates all core features in a single runnable file:
 *  - Schema definition with Zod validation & defaults
 *  - Insert, get, find, all (CRUD)
 *  - Three ways to query: .get, .find, .select, .query
 *  - Query operators ($gt, $in, $ne, $lt, $gte, $or)
 *  - z.lazy() relationships with auto FK columns
 *  - Lazy navigation: book.author(), author.books()
 *  - Entity references in insert & WHERE
 *  - Fluent .join() for cross-table queries
 *  - Proxy callback db.query() for SQL-like JOINs
 *  - Upsert, transactions, pagination
 *  - Schema validation at runtime
 *
 * Run: bun examples/example.ts
 */
import { Database, z } from '../src/index';

// =============================================================================
// 1. SCHEMAS
// =============================================================================

const UserSchema = z.object({
    name: z.string().min(1),
    email: z.string().email(),
    role: z.string().default('member'),
    score: z.number().int().default(0),
});

interface Author { name: string; country: string; books?: Book[]; }
interface Book { title: string; year: number; pages: number; author?: Author; }

const AuthorSchema: z.ZodType<Author> = z.object({
    name: z.string(),
    country: z.string(),
    books: z.lazy(() => z.array(BookSchema)).optional(),
});

const BookSchema: z.ZodType<Book> = z.object({
    title: z.string(),
    year: z.number(),
    pages: z.number(),
    author: z.lazy(() => AuthorSchema).optional(),
});

// =============================================================================
// 2. DATABASE — schemas + indexes
// =============================================================================

const db = new Database(':memory:', {
    users: UserSchema,
    authors: AuthorSchema,
    books: BookSchema,
}, {
    indexes: {
        users: ['email', ['name', 'role']],
        books: ['authorId', 'year'],
    },
});

// =============================================================================
// 3. CRUD — Insert, Get, Find, All, Update, Delete
// =============================================================================

console.log('── 1. CRUD ──');

// Insert (defaults fill in automatically)
const alice = db.users.insert({ name: 'Alice', email: 'alice@example.com', role: 'admin', score: 100 });
const bob = db.users.insert({ name: 'Bob', email: 'bob@example.com', score: 75 });
const carol = db.users.insert({ name: 'Carol', email: 'carol@example.com', score: 42 });

console.log('Inserted:', alice.name, bob.name, carol.name);
console.log('Bob default role:', bob.role); // → 'member'

// .get() — single row by ID or filter
const found = db.users.get(1);
console.log('Get by ID:', found?.name); // → 'Alice'

const admin = db.users.get({ role: 'admin' });
console.log('Get by filter:', admin?.name); // → 'Alice'

// .find() — array of rows matching conditions
const members = db.users.find({ role: 'member' });
console.log('Find members:', members.map(u => u.name)); // → ['Bob', 'Carol']

// .all() — every row
const everyone = db.users.all();
console.log('All users:', everyone.map(u => u.name)); // → ['Alice', 'Bob', 'Carol']

// Update by ID
alice.update({ score: 200 });
console.log('Updated score:', db.users.get(1)?.score); // → 200

// Fluent update with WHERE
const affected = db.users.update({ score: 0 }).where({ role: 'member' }).exec();
console.log('Reset member scores:', affected, 'rows');

// Delete
db.users.delete(carol.id);
console.log('After delete, total:', db.users.all().length); // → 2

// =============================================================================
// 4. FLUENT QUERIES — select().where().orderBy() + $or
// =============================================================================

console.log('\n── 2. Fluent Queries ──');

const topScorers = db.users.select()
    .where({ score: { $gt: 0 } })
    .orderBy('score', 'desc')
    .all();
console.log('Top scorers:', topScorers.map(u => `${u.name}: ${u.score}`));

const nonAdmins = db.users.select()
    .where({ role: { $ne: 'admin' } })
    .all();
console.log('Non-admins:', nonAdmins.map(u => u.name));

const specific = db.users.select()
    .where({ name: { $in: ['Alice', 'Bob'] } })
    .all();
console.log('In-query:', specific.map(u => u.name));

// $or — find admins OR high scorers
const adminsOrHighScore = db.users.select()
    .where({ $or: [{ role: 'admin' }, { score: { $gt: 50 } }] })
    .all();
console.log('Admins or high scorers:', adminsOrHighScore.map(u => `${u.name} (${u.role}, ${u.score})`));

// =============================================================================
// 5. RELATIONSHIPS — z.lazy() auto FK + entity references
// =============================================================================

console.log('\n── 3. Relationships ──');

// Insert authors
const tolstoy = db.authors.insert({ name: 'Leo Tolstoy', country: 'Russia' });
const dostoevsky = db.authors.insert({ name: 'Fyodor Dostoevsky', country: 'Russia' });
const kafka = db.authors.insert({ name: 'Franz Kafka', country: 'Czech Republic' });

// Insert books — pass entity directly, ORM resolves to FK
db.books.insert({ title: 'War and Peace', year: 1869, pages: 1225, author: tolstoy });
db.books.insert({ title: 'Anna Karenina', year: 1878, pages: 864, author: tolstoy });
db.books.insert({ title: 'Crime and Punishment', year: 1866, pages: 671, author: dostoevsky });
db.books.insert({ title: 'The Brothers Karamazov', year: 1880, pages: 796, author: dostoevsky });
db.books.insert({ title: 'The Trial', year: 1925, pages: 255, author: kafka });

console.log(`Seeded ${db.authors.all().length} authors, ${db.books.all().length} books`);

// Query with entity reference in WHERE
const tolstoyBooks = db.books.find({ author: tolstoy } as any);
console.log('Tolstoy books (.find):', tolstoyBooks.map(b => b.title));

const firstDostoevsky = db.books.get({ author: dostoevsky } as any);
console.log('First Dostoevsky (.get):', firstDostoevsky?.title);

// =============================================================================
// 6. LAZY NAVIGATION — book.author(), author.books()
// =============================================================================

console.log('\n── 4. Lazy Navigation ──');

// belongs-to: book → author
const warAndPeace = db.books.get({ title: 'War and Peace' })!;
const bookAuthor = warAndPeace.author();
console.log(`"${warAndPeace.title}" by ${bookAuthor.name} (${bookAuthor.country})`);

// one-to-many: author → books
const dostoevskyBooks = dostoevsky.books();
console.log(`Dostoevsky's books: ${dostoevskyBooks.map((b: any) => b.title).join(', ')}`);

// Chain: get author, then their books
const kafkaEntity = db.authors.get({ name: 'Franz Kafka' })!;
const kafkaBooks = kafkaEntity.books();
console.log(`Kafka's books: ${kafkaBooks.map((b: any) => b.title).join(', ')}`);

// =============================================================================
// 7. FLUENT JOIN — select().join() with auto FK inference
// =============================================================================

console.log('\n── 5. Fluent Join ──');

const booksWithAuthors = db.books.select('title', 'year', 'pages')
    .join(db.authors, ['name', 'country'])
    .orderBy('year', 'asc')
    .all();

console.log('All books with authors:');
for (const row of booksWithAuthors) {
    console.log(`  ${(row as any).year} - ${(row as any).title} by ${(row as any).authors_name} (${(row as any).authors_country})`);
}

// Filter joined results
const longBooks = db.books.select('title', 'pages')
    .join(db.authors, ['name'])
    .where({ pages: { $gt: 700 } })
    .orderBy('pages', 'desc')
    .all();
console.log('Long books:', longBooks.map((b: any) => `${b.title} (${b.pages}p) by ${b.authors_name}`));

// =============================================================================
// 8. PROXY CALLBACK — db.query() for SQL-like JOINs
// =============================================================================

console.log('\n── 6. Proxy Callback (SQL-like) ──');

const russianBooks = db.query((c) => {
    const { authors: a, books: b } = c;
    return {
        select: { author: a.name, book: b.title, year: b.year },
        join: [[b.author, a.id]],
        where: { [a.country]: 'Russia' },
        orderBy: { [b.year]: 'asc' },
    };
});

console.log('Russian books (proxy query):');
for (const row of russianBooks) {
    console.log(`  ${(row as any).year} - ${(row as any).book} by ${(row as any).author}`);
}

const latest = db.query((c) => {
    const { books: b, authors: a } = c;
    return {
        select: { title: b.title, author: a.name, year: b.year },
        join: [[b.author, a.id]],
        orderBy: { [b.year]: 'desc' },
        limit: 2,
    };
});
console.log('Latest 2 books:', latest.map((r: any) => `${r.title} (${r.year})`));

// =============================================================================
// 9. UPSERT & TRANSACTIONS
// =============================================================================

console.log('\n── 7. Upsert & Transactions ──');

db.users.upsert({ email: 'bob@example.com' }, { name: 'Bob', email: 'bob@example.com', role: 'moderator', score: 80 });
console.log('Bob after upsert:', db.users.get({ email: 'bob@example.com' })?.role);

db.users.upsert({ email: 'dave@example.com' }, { name: 'Dave', email: 'dave@example.com' });
console.log('Dave inserted via upsert:', db.users.get({ email: 'dave@example.com' })?.name);

db.transaction(() => {
    db.users.insert({ name: 'Eve', email: 'eve@example.com', role: 'member', score: 50 });
    db.users.update({ score: 999 }).where({ name: 'Alice' }).exec();
});
console.log('After transaction — Alice score:', db.users.get({ name: 'Alice' })?.score);
console.log('After transaction — Eve exists:', !!db.users.get({ name: 'Eve' }));

// =============================================================================
// 10. SCHEMA VALIDATION
// =============================================================================

console.log('\n── 8. Schema Validation ──');

try {
    db.users.insert({ name: '', email: 'bad', role: 'test', score: 0 });
} catch (e: any) {
    console.log('Validation error:', e.issues?.[0]?.message ?? e.message);
}

try {
    db.authors.insert({ name: 123 } as any);
} catch (e: any) {
    console.log('Type error caught:', e.issues?.[0]?.message ?? e.message);
}

console.log('\n✅ example.ts complete');
