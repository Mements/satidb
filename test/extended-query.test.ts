// test/extended-query.test.ts

import { describe, it, expect, beforeAll } from 'bun:test';
import { SatiDB, z } from '../satidb';

// Define schemas for testing
const UserSchema = z.object({
  name: z.string(),
  level: z.number(),
  sessions: z.lazy(() => z.array(SessionSchema)).optional(),
});

const SessionSchema = z.object({
  // The lazy-loaded relationship field should be optional
  // as we are providing the foreign key 'userId' on insert.
  userId: z.number().optional(),
  user: z.lazy(() => UserSchema).optional(),
  token: z.string(),
  expiresAt: z.date(),
});

describe('SatiDB - Extended Querying (findOne and Operators)', () => {
  let db: SatiDB<{ users: typeof UserSchema; sessions: typeof SessionSchema }>;

  // Setup: Initialize the database and insert test data
  beforeAll(() => {
    db = new SatiDB(':memory:', {
      users: UserSchema,
      sessions: SessionSchema,
    });

    // --- Create Users ---
    const user1 = db.users.insert({ name: 'Alice', level: 5 });
    const user2 = db.users.insert({ name: 'Bob', level: 10 });
    const user3 = db.users.insert({ name: 'Charlie', level: 10 });

    // --- Create Sessions ---
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
    const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    // When inserting a session, we provide the foreign key 'userId'.
    // The 'user' object itself will be lazy-loaded later.
    db.sessions.insert({ userId: user1.id, token: 'token_alice_expired', expiresAt: oneHourAgo });
    db.sessions.insert({ userId: user1.id, token: 'token_alice_active', expiresAt: oneHourFromNow });
    db.sessions.insert({ userId: user2.id, token: 'token_bob_active', expiresAt: twoHoursFromNow });
    db.sessions.insert({ userId: user3.id, token: 'token_charlie_active', expiresAt: twoHoursFromNow });
  });

  it('should find a single entity using findOne', () => {
    console.log('\n[Test] findOne: Finding user with name "Alice"...');
    const alice = db.users.findOne({ name: 'Alice' });

    expect(alice).not.toBeNull();
    expect(alice?.name).toBe('Alice');
    expect(alice?.level).toBe(5);
    console.log(` -> Found: ${alice?.name}`);
  });

  it('should return null with findOne if no entity matches', () => {
    console.log('\n[Test] findOne: Searching for a non-existent user "David"...');
    const david = db.users.findOne({ name: 'David' });

    expect(david).toBeNull();
    console.log(' -> Correctly returned null.');
  });

  it('should handle the $gt operator correctly, especially with dates', () => {
    console.log('\n[Test] Operator $gt: Finding all active (non-expired) sessions...');
    const activeSessions = db.sessions.find({
      expiresAt: { $gt: new Date() }
    });
    
    expect(activeSessions.length).toBe(3);
    const tokens = activeSessions.map(s => s.token).sort();
    console.log(` -> Found active tokens: [${tokens.join(', ')}]`);
    expect(tokens).toEqual(['token_alice_active', 'token_bob_active', 'token_charlie_active']);
  });
  
  it('should find a single active session using findOne with $gt', () => {
    console.log('\n[Test] findOne with $gt: Finding a single active session for Alice...');
    const alice = db.users.findOne({ name: 'Alice' });
    const activeAliceSession = db.sessions.findOne({
        userId: alice!.id,
        expiresAt: { $gt: new Date() }
    });

    expect(activeAliceSession).not.toBeNull();
    expect(activeAliceSession?.token).toBe('token_alice_active');
    console.log(` -> Found active session with token: ${activeAliceSession?.token}`);
  });

  it('should handle the $in operator to find multiple records', () => {
    console.log('\n[Test] Operator $in: Finding users named "Bob" or "Charlie"...');
    const users = db.users.find({
      name: { $in: ['Bob', 'Charlie'] }
    });

    expect(users.length).toBe(2);
    const names = users.map(u => u.name).sort();
    console.log(` -> Found users: [${names.join(', ')}]`);
    expect(names).toEqual(['Bob', 'Charlie']);
  });

  it('should combine multiple conditions and operators correctly', () => {
    console.log('\n[Test] Combined Query: Finding users with level 10 named "Bob" or "Charlie"...');
    const highLevelUsers = db.users.find({
      level: 10,
      name: { $in: ['Bob', 'Charlie', 'David'] } // David does not exist
    });

    expect(highLevelUsers.length).toBe(2);
    const names = highLevelUsers.map(u => u.name).sort();
    console.log(` -> Found users: [${names.join(', ')}]`);
    expect(names).toEqual(['Bob', 'Charlie']);
  });

  it('should return an empty array when $in operator has an empty list', () => {
    console.log('\n[Test] Operator $in: Using an empty array...');
    const users = db.users.find({ name: { $in: [] } });
    
    expect(users.length).toBe(0);
    console.log(' -> Correctly returned an empty array.');
  });
  
  console.log('\n✅ All extended query features tested successfully!');
});
