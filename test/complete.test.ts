import { describe, it, expect } from 'bun:test';
import { SatiDB, z } from '../satidb';

const UserSchema = z.object({
  name: z.string(),
  email: z.string().email(),
  age: z.number().optional(),
  posts: z.lazy(() => z.array(PostSchema)).optional(),
});

const PostSchema = z.object({
  title: z.string(),
  content: z.string(),
  published: z.boolean().default(false),
  author: z.lazy(() => UserSchema).optional(),
  comments: z.lazy(() => z.array(CommentSchema)).optional(),
});

const CommentSchema = z.object({
  text: z.string(),
  author: z.lazy(() => UserSchema).optional(),
  post: z.lazy(() => PostSchema).optional(),
});

describe('SatiDB Feature Documentation', () => {
  describe('Basic CRUD Operations', () => {
    it('should insert, get, update, and delete entities', () => {
      const db = new SatiDB(':memory:', {
        users: UserSchema,
        posts: PostSchema,
        comments: CommentSchema,
      });

      const user = db.users.insert({
        name: 'John Doe',
        email: 'john@example.com',
        age: 30
      });

      expect(user.name).toBe('John Doe');
      expect(user.id).toBeDefined();

      const foundUser = db.users.get(user.id);
      expect(foundUser?.name).toBe('John Doe');

      const updatedUser = db.users.update(user.id, { age: 31 });
      expect(updatedUser?.age).toBe(31);

      db.users.delete(user.id);
      const deletedUser = db.users.get(user.id);
      expect(deletedUser).toBeNull();
    });

    it('should find entities with various conditions', () => {
      const db = new SatiDB(':memory:', {
        users: UserSchema,
        posts: PostSchema,
        comments: CommentSchema,
      });

      db.users.insert({ name: 'Alice', email: 'alice@example.com', age: 25 });
      db.users.insert({ name: 'Bob', email: 'bob@example.com', age: 30 });
      db.users.insert({ name: 'Charlie', email: 'charlie@example.com', age: 35 });

      const allUsers = db.users.find();
      expect(allUsers.length).toBe(3);

      const youngUser = db.users.find({ age: 25 });
      expect(youngUser[0].name).toBe('Alice');

      const limitedUsers = db.users.find({ $limit: 2 });
      expect(limitedUsers.length).toBe(2);

      const sortedUsers = db.users.find({ $sortBy: 'age:desc' });
      expect(sortedUsers[0].age).toBe(35);

      const paginatedUsers = db.users.find({ $limit: 1, $offset: 1, $sortBy: 'name:asc' });
      expect(paginatedUsers[0].name).toBe('Bob');
    });
  });

  describe('Schema Validation', () => {
    it('should validate data according to Zod schemas', () => {
      const db = new SatiDB(':memory:', {
        users: UserSchema,
        posts: PostSchema,
        comments: CommentSchema,
      });

      const user = db.users.insert({
        name: 'Jane',
        email: 'jane@example.com'
      });

      expect(user.name).toBe('Jane');
      expect(user.age).toBeUndefined();

      const post = db.posts.insert({
        title: 'My First Post',
        content: 'Hello world!',
        authorId: user.id
      });

      expect(post.published).toBe(false);
    });
  });

  describe('Upsert Operations', () => {
    it('should insert new entities or update existing ones', () => {
      const db = new SatiDB(':memory:', {
        users: UserSchema,
        posts: PostSchema,
        comments: CommentSchema,
      });

      const user1 = db.users.upsert({ email: 'new@example.com' }, {
        name: 'New User',
        email: 'new@example.com',
        age: 25
      });

      expect(user1.name).toBe('New User');

      const user2 = db.users.upsert({ email: 'new@example.com' }, {
        name: 'Updated User',
        email: 'new@example.com',
        age: 26
      });

      expect(user2.id).toBe(user1.id);
      expect(user2.name).toBe('Updated User');
      expect(user2.age).toBe(26);
    });
  });

  describe('Relationship Management', () => {
    it('should handle belongs-to relationships with lazy loading', () => {
      const db = new SatiDB(':memory:', {
        users: UserSchema,
        posts: PostSchema,
        comments: CommentSchema,
      });

      const user = db.users.insert({
        name: 'Author',
        email: 'author@example.com'
      });

      const post = db.posts.insert({
        title: 'Test Post',
        content: 'Content here',
        authorId: user.id
      });

      const author = post.author();
      expect(author?.name).toBe('Author');
    });

    it('should handle one-to-many relationships with lazy loading', () => {
      const db = new SatiDB(':memory:', {
        users: UserSchema,
        posts: PostSchema,
        comments: CommentSchema,
      });

      const user = db.users.insert({
        name: 'Blogger',
        email: 'blogger@example.com'
      });

      user.posts.insert({
        title: 'First Post',
        content: 'My first blog post'
      });

      user.posts.insert({
        title: 'Second Post',
        content: 'My second blog post'
      });

      const posts = user.posts.find();
      expect(posts.length).toBe(2);
      expect(posts[0].title).toBe('First Post');
    });

    it('should use relationship managers for CRUD operations', () => {
      const db = new SatiDB(':memory:', {
        users: UserSchema,
        posts: PostSchema,
        comments: CommentSchema,
      });

      const user = db.users.insert({
        name: 'Content Creator',
        email: 'creator@example.com'
      });

      const post = user.posts.push({
        title: 'New Post',
        content: 'Fresh content'
      });

      expect(post.title).toBe('New Post');

      const foundPost = user.posts.get(post.id);
      expect(foundPost?.title).toBe('New Post');

      const updatedPost = user.posts.update(post.id, {
        title: 'Updated Post'
      });
      expect(updatedPost?.title).toBe('Updated Post');

      const upsertedPost = user.posts.upsert({ title: 'Updated Post' }, {
        content: 'Updated content'
      });
      expect(upsertedPost?.content).toBe('Updated content');

      user.posts.delete(post.id);
      const deletedPost = user.posts.get(post.id);
      expect(deletedPost).toBeNull();
    });
  });

  describe('Eager Loading with $include', () => {
    it('should load belongs-to relationships eagerly', () => {
      const db = new SatiDB(':memory:', {
        users: UserSchema,
        posts: PostSchema,
        comments: CommentSchema,
      });

      const user = db.users.insert({
        name: 'Writer',
        email: 'writer@example.com'
      });

      db.posts.insert({
        title: 'Post 1',
        content: 'Content 1',
        authorId: user.id
      });

      db.posts.insert({
        title: 'Post 2',
        content: 'Content 2',
        authorId: user.id
      });

      const postsWithAuthors = db.posts.find({ $include: 'author' });
      expect(postsWithAuthors.length).toBe(2);
      expect(postsWithAuthors[0].author()?.name).toBe('Writer');
      expect(postsWithAuthors[1].author()?.name).toBe('Writer');
    });

    it('should load one-to-many relationships eagerly', () => {
      const db = new SatiDB(':memory:', {
        users: UserSchema,
        posts: PostSchema,
        comments: CommentSchema,
      });

      const user1 = db.users.insert({
        name: 'User One',
        email: 'user1@example.com'
      });

      const user2 = db.users.insert({
        name: 'User Two',
        email: 'user2@example.com'
      });

      user1.posts.insert({ title: 'Post A', content: 'Content A' });
      user1.posts.insert({ title: 'Post B', content: 'Content B' });
      user2.posts.insert({ title: 'Post C', content: 'Content C' });

      const usersWithPosts = db.users.find({ $include: 'posts' });
      expect(usersWithPosts.length).toBe(2);

      const user1Posts = usersWithPosts.find(u => u.name === 'User One')?.posts.find();
      const user2Posts = usersWithPosts.find(u => u.name === 'User Two')?.posts.find();

      expect(user1Posts?.length).toBe(2);
      expect(user2Posts?.length).toBe(1);
    });

    it('should load multiple relationships simultaneously', () => {
      const db = new SatiDB(':memory:', {
        users: UserSchema,
        posts: PostSchema,
        comments: CommentSchema,
      });

      const user = db.users.insert({
        name: 'Commenter',
        email: 'commenter@example.com'
      });

      const post = db.posts.insert({
        title: 'Popular Post',
        content: 'This post has comments',
        authorId: user.id
      });

      db.comments.insert({
        text: 'Great post!',
        authorId: user.id,
        postId: post.id
      });

      const commentsWithRelations = db.comments.find({
        $include: ['author', 'post']
      });

      expect(commentsWithRelations[0].author()?.name).toBe('Commenter');
      expect(commentsWithRelations[0].post()?.title).toBe('Popular Post');
    });
  });

  describe('Event Subscriptions', () => {
    it('should emit events for insert, update, and delete operations', () => {
      const db = new SatiDB(':memory:', {
        users: UserSchema,
        posts: PostSchema,
        comments: CommentSchema,
      });

      let insertedUser: any = null;
      let updatedUser: any = null;
      let deletedUser: any = null;

      db.users.subscribe('insert', (user) => {
        insertedUser = user;
      });

      db.users.subscribe('update', (user) => {
        updatedUser = user;
      });

      db.users.subscribe('delete', (user) => {
        deletedUser = user;
      });

      const user = db.users.insert({
        name: 'Test User',
        email: 'test@example.com'
      });

      expect(insertedUser?.name).toBe('Test User');

      db.users.update(user.id, { name: 'Updated User' });
      expect(updatedUser?.name).toBe('Updated User');

      db.users.delete(user.id);
      expect(deletedUser?.name).toBe('Updated User');
    });
  });

  describe('Reactive Updates', () => {
    it('should automatically update database when entity properties change', () => {
      const db = new SatiDB(':memory:', {
        users: UserSchema,
        posts: PostSchema,
        comments: CommentSchema,
      });

      let updatedUser: any = null;

      db.users.subscribe('update', (user) => {
        updatedUser = user;
      });

      const user = db.users.insert({
        name: 'Reactive User',
        email: 'reactive@example.com',
        age: 25
      });

      user.age = 26;

      expect(updatedUser?.age).toBe(26);

      const retrievedUser = db.users.get(user.id);
      expect(retrievedUser?.age).toBe(26);
    });
  });

  describe('Transactions', () => {
    it('should execute multiple operations atomically', () => {
      const db = new SatiDB(':memory:', {
        users: UserSchema,
        posts: PostSchema,
        comments: CommentSchema,
      });

      const result = db.transaction(() => {
        const user = db.users.insert({
          name: 'Transaction User',
          email: 'transaction@example.com'
        });

        const post = db.posts.insert({
          title: 'Transaction Post',
          content: 'Created in transaction',
          authorId: user.id
        });

        return { user, post };
      });

      expect(result.user.name).toBe('Transaction User');
      expect(result.post.title).toBe('Transaction Post');

      const foundUser = db.users.get(result.user.id);
      const foundPost = db.posts.get(result.post.id);

      expect(foundUser?.name).toBe('Transaction User');
      expect(foundPost?.title).toBe('Transaction Post');
    });

    it('should rollback on transaction failure', () => {
      const db = new SatiDB(':memory:', {
        users: UserSchema,
        posts: PostSchema,
        comments: CommentSchema,
      });

      expect(() => {
        db.transaction(() => {
          db.users.insert({
            name: 'Failed User',
            email: 'failed@example.com'
          });

          throw new Error('Transaction failed');
        });
      }).toThrow('Transaction failed');

      const users = db.users.find({ name: 'Failed User' });
      expect(users.length).toBe(0);
    });
  });

  describe('Complex Relationship Scenarios', () => {
    it('should handle deep relationship chains', () => {
      const db = new SatiDB(':memory:', {
        users: UserSchema,
        posts: PostSchema,
        comments: CommentSchema,
      });

      const author = db.users.insert({
        name: 'Blog Author',
        email: 'author@blog.com'
      });

      const commenter = db.users.insert({
        name: 'Commenter',
        email: 'commenter@blog.com'
      });

      const post = author.posts.insert({
        title: 'Interesting Article',
        content: 'This is a fascinating topic...'
      });

      const comment = post.comments.insert({
        text: 'Thanks for sharing!',
        authorId: commenter.id
      });

      expect(comment.author()?.name).toBe('Commenter');
      expect(comment.post()?.title).toBe('Interesting Article');
      expect(comment.post()?.author()?.name).toBe('Blog Author');
    });

    it('should handle many-to-many relationships through junction entities', () => {
      const TagSchema = z.object({
        name: z.string(),
        posts: z.lazy(() => z.array(PostTagSchema)).optional(),
      });

      const PostTagSchema = z.object({
        post: z.lazy(() => PostSchema).optional(),
        tag: z.lazy(() => TagSchema).optional(),
      });

      const db = new SatiDB(':memory:', {
        users: UserSchema,
        posts: PostSchema,
        tags: TagSchema,
        postTags: PostTagSchema,
      });

      const user = db.users.insert({
        name: 'Tagger',
        email: 'tagger@example.com'
      });

      const post = user.posts.insert({
        title: 'Tagged Post',
        content: 'This post has tags'
      });

      const tag1 = db.tags.insert({ name: 'javascript' });
      const tag2 = db.tags.insert({ name: 'database' });

      db.postTags.insert({ postId: post.id, tagId: tag1.id });
      db.postTags.insert({ postId: post.id, tagId: tag2.id });

      const postTags = db.postTags.find({ postId: post.id });
      expect(postTags.length).toBe(2);

      const tagNames = postTags.map(pt => pt.tag()?.name).sort();
      expect(tagNames).toEqual(['database', 'javascript']);
    });
  });

  describe('Advanced Query Features', () => {
    it('should combine query options with eager loading', () => {
      const db = new SatiDB(':memory:', {
        users: UserSchema,
        posts: PostSchema,
        comments: CommentSchema,
      });

      const user = db.users.insert({
        name: 'Prolific Writer',
        email: 'writer@example.com'
      });

      for (let i = 1; i <= 10; i++) {
        user.posts.insert({
          title: `Post ${i}`,
          content: `Content for post ${i}`,
          published: i % 2 === 0
        });
      }

      const recentPublishedPosts = db.posts.find({
        published: true,
        $include: 'author',
        $limit: 3,
        $sortBy: 'title:desc'
      });

      expect(recentPublishedPosts.length).toBe(3);
      expect(recentPublishedPosts[0].title).toBe('Post 8');
      expect(recentPublishedPosts[0].author()?.name).toBe('Prolific Writer');
    });

    it('should handle entity method chaining', () => {
      const db = new SatiDB(':memory:', {
        users: UserSchema,
        posts: PostSchema,
        comments: CommentSchema,
      });

      const user = db.users.insert({
        name: 'Chain User',
        email: 'chain@example.com'
      });

      const post = user.posts.insert({
        title: 'Chainable Post',
        content: 'Testing method chaining'
      });

      const updatedPost = post.update({
        title: 'Updated Chainable Post'
      });

      expect(updatedPost?.title).toBe('Updated Chainable Post');

      const retrievedPost = db.posts.get(post.id);
      expect(retrievedPost?.title).toBe('Updated Chainable Post');
    });
  });
});