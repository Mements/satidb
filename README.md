# SatiDB 🗄️

A modern, type-safe SQLite wrapper with **reactive editing**, **automatic relationships**, and **fluent APIs**. Built for TypeScript/JavaScript with Zod schema validation.

## ✨ Key Features

- **🔄 Reactive Editing**: Change properties directly, auto-persists to database
- **📊 Type-Safe Schemas**: Powered by Zod for runtime validation
- **🔗 Automatic Relationships**: Belongs-to, one-to-many, many-to-many support
- **📺 Event Subscriptions**: Listen to insert/update/delete events
- **🏗️ Explicit Junction Tables**: Full control over many-to-many relationships
- **🚀 Fluent API**: Intuitive, chainable operations
- **⚡ Zero-Config**: Works with Bun SQLite out of the box

## 🚀 Quick Start

```typescript
import { MyDatabase, z } from './satidb';

// Define schemas with relationships
const AuthorSchema = z.object({
  name: z.string(),
  posts: z.lazy(() => z.array(PostSchema)).optional(),
});

const PostSchema = z.object({
  title: z.string(),
  content: z.string(),
  author: z.lazy(() => AuthorSchema).optional(),
});

// Create database
const db = new MyDatabase(':memory:', {
  authors: AuthorSchema,
  posts: PostSchema,
});

// Use it!
const author = db.authors.insert({ name: 'Jane Doe' });
const post = author.posts.push({ title: 'Hello World', content: '...' });

// Reactive editing - just change properties!
post.title = 'Hello TypeScript'; // Automatically saved to DB
```

## 📖 Core Concepts

### Schemas & Relationships

Define entities using Zod schemas with lazy relationships:

```typescript
// One-to-many: Author has many Posts
const AuthorSchema = z.object({
  name: z.string(),
  posts: z.lazy(() => z.array(PostSchema)).optional(), // one-to-many
});

// Belongs-to: Post belongs to Author  
const PostSchema = z.object({
  title: z.string(),
  author: z.lazy(() => AuthorSchema).optional(), // belongs-to
});
```

### Explicit Junction Tables

For many-to-many relationships, define explicit junction entities with additional fields:

```typescript
// Many-to-many with rich junction table
const PostTagSchema = z.object({
  post: z.lazy(() => PostSchema).optional(),
  tag: z.lazy(() => TagSchema).optional(),
  appliedAt: z.date().default(() => new Date()),
  appliedBy: z.string(),
  priority: z.number().default(0),
});

// Usage
const postTag = post.postTags.push({ 
  tagId: tag.id, 
  appliedBy: 'editor',
  priority: 5 
});
```

**Why explicit junction tables?**
- Full control over additional fields (timestamps, metadata, etc.)
- Junction tables are queryable entities themselves
- More flexible than auto-generated tables
- Clearer data modeling

## 🎯 API Reference

### Creating & Querying

```typescript
// Insert new entities
const user = db.users.insert({ name: 'Alice', email: 'alice@example.com' });

// Find multiple with conditions
const activeUsers = db.users.find({ active: true, $limit: 10 });

// Get single entity
const user = db.users.get({ email: 'alice@example.com' });
const userById = db.users.get('user-id-123');

// Update
const updated = db.users.update('user-id', { name: 'Alice Smith' });

// Upsert
const user = db.users.upsert({ email: 'alice@example.com', name: 'Alice' });

// Delete
db.users.delete('user-id');
```

### Relationships

```typescript
// One-to-many: Add related entities
const post = author.posts.push({ title: 'New Post', content: '...' });

// Query related entities
const authorPosts = author.posts(); // All posts
const recentPosts = author.posts({ $limit: 5, $sortBy: 'createdAt:desc' });

// Belongs-to: Navigate relationships
const postAuthor = post.author();

// Get specific related entity
const specificPost = author.post('post-id-123');
```

### Reactive Editing

```typescript
const user = db.users.get('user-id');

// Just change properties - automatically persists!
user.name = 'New Name';
user.email = 'new@email.com';
user.active = false;

// No need to call .save() or .update()
// Changes are immediately persisted to database
```

### Event Subscriptions

```typescript
// Listen to database events
db.users.subscribe('insert', (user) => {
  console.log(`New user: ${user.name}`);
});

db.posts.subscribe('update', (post) => {
  console.log(`Post updated: ${post.title}`);
});

db.users.subscribe('delete', (user) => {
  console.log(`User deleted: ${user.name}`);
});
```

### Transactions

```typescript
const result = db.transaction(() => {
  const author = db.authors.insert({ name: 'Jane' });
  const post1 = author.posts.push({ title: 'Post 1' });
  const post2 = author.posts.push({ title: 'Post 2' });
  return { author, posts: [post1, post2] };
});
```

## 🔗 Relationship Types

### One-to-Many

```typescript
const PersonalitySchema = z.object({
  name: z.string(),
  chats: z.lazy(() => z.array(ChatSchema)).optional(),
});

const ChatSchema = z.object({
  title: z.string(),
  personality: z.lazy(() => PersonalitySchema).optional(),
});

// Usage
const personality = db.personalities.insert({ name: 'Assistant' });
const chat = personality.chats.push({ title: 'Help Session' });
const chatPersonality = chat.personality(); // Navigate back
```

### Many-to-Many (Explicit Junction)

```typescript
// Define all three entities
const UserSchema = z.object({
  name: z.string(),
  likes: z.lazy(() => z.array(LikeSchema)).optional(),
});

const ProductSchema = z.object({
  name: z.string(),
  likes: z.lazy(() => z.array(LikeSchema)).optional(),
});

// Junction table with additional fields
const LikeSchema = z.object({
  user: z.lazy(() => UserSchema).optional(),
  product: z.lazy(() => ProductSchema).optional(),
  rating: z.number().min(1).max(5),
  likedAt: z.date().default(() => new Date()),
});

// Usage
const user = db.users.insert({ name: 'Alice' });
const product = db.products.insert({ name: 'Laptop' });

// Create relationship with metadata
const like = user.likes.push({ 
  productId: product.id, 
  rating: 5 
});

// Query from both sides
const userLikes = user.likes().map(l => l.product()); // Products Alice likes
const productLikers = product.likes().map(l => l.user()); // Users who like laptop

// Junction table is a full entity
like.rating = 4; // Reactive update on junction table!
```

## 📝 Advanced Usage

### Custom ID Generation

IDs are automatically generated based on entity data hash. For custom IDs:

```typescript
const entity = db.entities.insert({ 
  id: 'custom-id-123', // Explicit ID
  name: 'Custom Entity' 
});
```

### Query Options

```typescript
const results = db.posts.find({
  published: true,
  $limit: 10,
  $offset: 20,
  $sortBy: 'createdAt:desc'
});
```

### Schema Validation

All data is validated against Zod schemas:

```typescript
const UserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  age: z.number().optional(),
});

// Throws validation error if invalid
const user = db.users.insert({ 
  name: 'A', // Too short!
  email: 'invalid-email' // Invalid format!
});
```

## 🎯 Best Practices

1. **Use Explicit Junction Tables**: Define junction entities with additional fields rather than relying on auto-generated tables
2. **Leverage Reactive Editing**: Change properties directly instead of calling update methods
3. **Subscribe to Events**: Use subscriptions for real-time updates and side effects
4. **Validate with Zod**: Define comprehensive schemas with proper validation rules
5. **Use Transactions**: Wrap related operations in transactions for data consistency

## 🔄 Migration from Traditional ORMs

```typescript
// Traditional ORM
const user = await User.findById(id);
user.name = 'New Name';
await user.save(); // Explicit save

// SatiDB
const user = db.users.get(id);
user.name = 'New Name'; // Automatically saved!
```

## 🛠️ Requirements

- Bun runtime with SQLite support
- TypeScript (recommended) or JavaScript
- Zod for schema validation

## 📄 License

MIT License - feel free to use in your projects!

---

**SatiDB** - Reactive, type-safe database operations made simple. 🚀
