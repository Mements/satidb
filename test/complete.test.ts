import { describe, it, expect } from 'bun:test';
import { SatiDB, z } from '../satidb';

const AuthorSchema = z.object({
  name: z.string(),
  posts: z.lazy(() => z.array(PostSchema)).optional(),
});

const PostSchema = z.object({
  title: z.string(),
  publishedAt: z.date().optional(),
  author: z.lazy(() => AuthorSchema).optional(),
  post_tags: z.lazy(() => z.array(PostTagSchema)).optional(),
});

const TagSchema = z.object({
  name: z.string(),
  post_tags: z.lazy(() => z.array(PostTagSchema)).optional(),
});

const PostTagSchema = z.object({
  postId: z.number().optional(),
  tagId: z.number().optional(),
  post: z.lazy(() => PostSchema).optional(),
  tag: z.lazy(() => TagSchema).optional(),
});

describe('SatiDB - Documentation Showcase', () => {
  it('should demonstrate all core features of the library', () => {
    const db = new SatiDB(':memory:', {
      authors: AuthorSchema,
      posts: PostSchema,
      tags: TagSchema,
      post_tags: PostTagSchema,
    });

    let updatedPostTitle: string | null = null;
    db.posts.subscribe('update', (data) => {
      updatedPostTitle = data.title;
    });

    const author = db.authors.insert({ name: 'Jane Doe' });
    const tagTech = db.tags.insert({ name: 'Tech' });
    const tagBun = db.tags.insert({ name: 'Bun' });

    const post1 = author.posts.push({ 
      title: 'Intro to SatiDB', 
      publishedAt: new Date('2025-07-21') 
    });
    const post2 = author.posts.push({
      title: 'Advanced SatiDB',
      publishedAt: new Date('2025-09-15')
    });

    db.post_tags.insert({ post: { id: post1.id }, tag: tagTech });
    db.post_tags.insert({ post: post1, tag: tagBun });
    db.post_tags.insert({ post: post2, tag: tagTech });

    post1.title = 'Introduction to SatiDB';
    expect(updatedPostTitle).toBe('Introduction to SatiDB');

    const foundAuthor = db.authors.findOne({ name: 'Jane Doe' });
    expect(foundAuthor?.id).toBe(author.id);

    const recentPosts = db.posts.find({ publishedAt: { $gt: new Date('2025-08-01') } });
    expect(recentPosts.length).toBe(1);
    expect(recentPosts[0].title).toBe('Advanced SatiDB');

    const janesPosts = author.posts.find({ $sortBy: 'publishedAt:asc' });
    expect(janesPosts.length).toBe(2);
    expect(janesPosts[0].title).toBe('Introduction to SatiDB');

    const techPosts = db.tags.findOne({ name: 'Tech' })
      .post_tags.find()
      .map(pt => pt.post());
    expect(techPosts.length).toBe(2);
    expect(techPosts.map(p => p.title).sort()).toEqual(['Advanced SatiDB', 'Introduction to SatiDB']);

    const post1Tags = post1.post_tags.find({ '$include': ['tag'] }).map(pt => pt.tag());
    expect(post1Tags.map(t => t.name).sort()).toEqual(['Bun', 'Tech']);

    const post1BunTagLink = db.post_tags.findOne({ postId: post1.id, tagId: tagBun.id });
    expect(post1BunTagLink).not.toBeNull();
    post1BunTagLink.delete();

    const post1TagsAfterRemove = post1.post_tags.find().map(pt => pt.tag());
    expect(post1TagsAfterRemove.length).toBe(1);
    expect(post1TagsAfterRemove[0].name).toBe('Tech');

    db.authors.delete(author.id);
    const deletedAuthor = db.authors.get(author.id);
    expect(deletedAuthor).toBeNull();

    const orphanedPost = db.posts.get(post1.id);
    expect(orphanedPost).not.toBeNull();
    expect(orphanedPost.authorId).toBeNull();
  });
});