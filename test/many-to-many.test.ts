import { describe, it, expect } from 'bun:test';
import { SatiDB, z } from '../satidb';

// --- Schemas for Many-to-Many Test ---
const UserSchema = z.object({
  name: z.string(),
  likes: z.lazy(() => z.array(LikeSchema)).optional(),
});

const ProductSchema = z.object({
  name: z.string(),
  likes: z.lazy(() => z.array(LikeSchema)).optional(),
});

// Junction table
const LikeSchema = z.object({
  userId: z.number().optional(),
  productId: z.number().optional(),
  user: z.lazy(() => UserSchema).optional(),
  product: z.lazy(() => ProductSchema).optional(),
});

describe('SatiDB - Many-to-Many Relationships', () => {
  const db = new SatiDB(':memory:', {
    users: UserSchema,
    products: ProductSchema,
    likes: LikeSchema, // The junction table is an explicit entity
  });

  it('should handle many-to-many relationships fluently', () => {
    // 1. Create users and products
    const alice = db.users.insert({ name: 'Alice' });
    const bob = db.users.insert({ name: 'Bob' });
    console.log(`✅ Created users: ${alice.name}, ${bob.name}`);

    const laptop = db.products.insert({ name: 'Laptop' });
    const keyboard = db.products.insert({ name: 'Keyboard' });
    console.log(`✅ Created products: ${laptop.name}, ${keyboard.name}`);

    // 2. Create relationships using the fluent '.likes.push()' API.
    // The library automatically creates the inverse relationship manager on the User and Product objects.
    const like1 = alice.likes.push({ productId: laptop.id });
    const like2 = bob.likes.push({ productId: laptop.id });
    bob.likes.push({ productId: keyboard.id });
    console.log('✅ Created 3 likes');

    expect(like1.userId).toBe(alice.id);
    expect(like1.productId).toBe(laptop.id);

    // 3. Query from the "product" side
    console.log(`\n🔍 Querying who liked "${laptop.name}"...`);
    const laptopLikes = laptop.likes.find();
    expect(laptopLikes).toHaveLength(2);

    const usersWhoLikedLaptop = laptopLikes.map(l => l.user());
    const userNames = usersWhoLikedLaptop.map(u => u.name).sort();
    console.log(`  -> Liked by: ${userNames.join(', ')}`);
    expect(userNames).toEqual(['Alice', 'Bob']);

    // 4. Query from the "user" side
    console.log(`\n🔍 Querying what "${bob.name}" likes...`);
    const bobLikes = bob.likes.find();
    expect(bobLikes).toHaveLength(2);

    const productsBobLiked = bobLikes.map(l => l.product());
    const productNames = productsBobLiked.map(p => p.name).sort();
    console.log(`  -> Likes: ${productNames.join(', ')}`);
    expect(productNames).toEqual(['Keyboard', 'Laptop']);

    // 5. Demonstrate filtering on relational queries
    const singleProductBobLiked = bob.likes.find({ $limit: 1 });
    expect(singleProductBobLiked).toHaveLength(1);
    console.log(`\n✅ Successfully filtered user's likes with $limit.`);

    // 6. Demonstrate singular relationship fetch
    const firstLike = db.likes.get(like1.id);
    const productFromLike = firstLike.product();
    const userFromLike = firstLike.user();
    console.log(`\n✅ Fetched like ${firstLike.id}: ${userFromLike.name} likes ${productFromLike.name}`);
    expect(productFromLike.id).toBe(laptop.id);
    expect(userFromLike.id).toBe(alice.id);

    // 7. Demonstrate reactive update on M-M entity
    console.log('\n✨ Testing reactive update on a user...');
    const originalBobName = bob.name;
    bob.name = 'Robert';
    console.log(`  -> Changed user name from "${originalBobName}" to "${bob.name}"`);
    const refetchedBob = db.users.get(bob.id);
    expect(refetchedBob.name).toBe('Robert');
    console.log('✅ Reactive update successful!');
  });
});
