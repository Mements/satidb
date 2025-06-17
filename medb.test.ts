import { describe, it, expect } from 'bun:test';
import { MyDatabase, z, PersonalitySchema, ChatSchema, MessageSchema, WalletSchema, WalletSessionSchema } from './medb';

describe('MyDatabase', () => {
  // Initialize database
  const db = new MyDatabase(':memory:', {
    personalities: PersonalitySchema,
    chats: ChatSchema,
    messages: MessageSchema,
    wallets: WalletSchema,
    wallet_sessions: WalletSessionSchema,
  });

  // Track total chats per personality
  const totalChats = new Map<string, number>();

  // Subscribe to chat events
  db.chats.subscribe('insert', async (chat: { personalityId: string }) => {
    const personalityId = chat.personalityId;
    totalChats.set(personalityId, (totalChats.get(personalityId) || 0) + 1);
  });

  db.chats.subscribe('delete', async (chatId: string) => {
    const chat = await db.chats.get({ id: chatId });
    if (chat) {
      const personalityId = chat.personalityId;
      totalChats.set(personalityId, (totalChats.get(personalityId) || 0) - 1);
    }
  });

  db.messages.subscribe('update', (updatedMessage: { content: string }) => {
    console.log('Message updated:', updatedMessage.content);
  });

  it('should insert and retrieve a personality', async () => {
    const personality = {
      id: 'p1',
      name: 'Personality One',
      description: 'A test personality',
      shortDescription: 'Test',
      category: 'General',
      prompt: 'Hello',
    };
    await db.personalities.insert(personality);

    const fetched = await db.personalities.get({ id: 'p1' });
    expect(fetched).toBeTruthy();
    expect(fetched!.name).toBe('Personality One');
    expect(fetched!.isPublic).toBe(true);
    expect(fetched!.creator).toBe('User');
    expect(fetched!.created_at).toBeInstanceOf(Date);
  });

  it('should insert a chat and link it to a personality', async () => {
    const chat = {
      id: 'c1',
      title: 'Chat One',
      personalityId: 'p1',
    };
    await db.chats.insert(chat);

    const fetchedPersonality = await db.personalities.get({ id: 'p1' });
    const chats = await fetchedPersonality!.chats();
    expect(chats).toHaveLength(1);
    expect(chats[0].id).toBe('c1');
    expect(chats[0].title).toBe('Chat One');

    const fetchedChat = await db.chats.get({ id: 'c1' });
    const personality = await fetchedChat!.personality();
    expect(personality.id).toBe('p1');

    expect(totalChats.get('p1')).toBe(1);
  });

  it('should insert a message and link it to a chat', async () => {
    const message = {
      id: 'm1',
      chatId: 'c1',
      content: 'Hi there',
      isUser: true,
    };
    await db.messages.insert(message);

    const fetchedChat = await db.chats.get({ id: 'c1' });
    const messages = await fetchedChat!.messages();
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
    expect(messages[0].content).toBe('Hi there');

    const fetchedMessage = await db.messages.get({ id: 'm1' });
    const chat = await fetchedMessage!.chat();
    expect(chat.id).toBe('c1');
  });

  it('should insert a wallet and link it to a personality', async () => {
    const wallet = {
      personalityId: 'p1',
      publicKey: 'pubkey1',
      privateKey: 'privkey1',
    };
    await db.wallets.insert(wallet);

    const fetchedPersonality = await db.personalities.get({ id: 'p1' });
    const wallets = await fetchedPersonality!.wallets();
    expect(wallets).toHaveLength(1);
    expect(wallets[0].publicKey).toBe('pubkey1');

    const fetchedWallet = await db.wallets.get({ personalityId: 'p1' });
    const personality = await fetchedWallet!.personality();
    expect(personality.id).toBe('p1');
  });

  it('should insert a wallet session', async () => {
    const walletSession = {
      wallet_address: 'addr1',
      session_token: 'token1',
    };
    await db.wallet_sessions.insert(walletSession);

    const fetchedSession = await db.wallet_sessions.get({ wallet_address: 'addr1' });
    expect(fetchedSession).toBeTruthy();
    expect(fetchedSession!.session_token).toBe('token1');
    expect(fetchedSession!.created_at).toBeInstanceOf(Date);
  });

  it('should handle chat deletion and update total chats', async () => {
    await db.chats.delete('c1');
    expect(totalChats.get('p1')).toBe(0);
  });

  it('should handle message updates for LLM streaming', async () => {
    await db.chats.insert({
      id: 'c2',
      title: 'Chat Two',
      personalityId: 'p1',
    });
    await db.messages.insert({
      id: 'm2',
      chatId: 'c2',
      content: 'Initial message',
      isUser: false,
    });

    await db.messages.update('m2', { content: 'Updated message with more tokens' });

    const updatedMessage = await db.messages.get({ id: 'm2' });
    expect(updatedMessage!.content).toBe('Updated message with more tokens');
  });

  it('should find multiple entities', async () => {
    await db.personalities.insert({
      id: 'p2',
      name: 'Personality Two',
      description: 'Another test personality',
      shortDescription: 'Test2',
      category: 'General',
      prompt: 'Hi',
    });
    await db.chats.insert({
      id: 'c3',
      title: 'Chat Three',
      personalityId: 'p2',
    });

    const personalities = await db.personalities.find();
    expect(personalities).toHaveLength(2);
    expect(personalities.map(p => p.id)).toContain('p1');
    expect(personalities.map(p => p.id)).toContain('p2');

    const chats = await db.chats.find({ personalityId: 'p2' });
    expect(chats).toHaveLength(1);
    expect(chats[0].id).toBe('c3');
  });
});