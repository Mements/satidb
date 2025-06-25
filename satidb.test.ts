import { describe, it, expect } from 'bun:test';
import { MyDatabase, z } from './medb';

// Schemas
const PersonalitySchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  description: z.string(),
  chats: z.lazy(() => z.array(ChatSchema)).optional(),
});

const ChatSchema = z.object({
  id: z.string().optional(),
  title: z.string(),
  personality: z.lazy(() => PersonalitySchema).optional(),
  messages: z.lazy(() => z.array(MessageSchema)).optional(),
});

const MessageSchema = z.object({
  id: z.string().optional(),
  content: z.string(),
  isUser: z.boolean(),
  timestamp: z.date().default(() => new Date()),
  chat: z.lazy(() => ChatSchema).optional(),
});

describe('MyDatabase - LLM Streaming Scenario', () => {
  const db = new MyDatabase(':memory:', {
    personalities: PersonalitySchema,
    chats: ChatSchema,
    messages: MessageSchema,
  });

  it('should demonstrate LLM response generation and streaming updates', () => {
    const streamingUpdates: any[] = [];
    
    // Subscribe to updates on the 'messages' table to simulate client-side listening
    db.messages.subscribe('update', (updatedMessage) => {
      console.log(`🤖 LLM Stream Update: "${updatedMessage.content}"`);
      streamingUpdates.push(updatedMessage);
    });

    // 1. Create a personality
    const personality = db.personalities.insert({
      name: 'AI Assistant',
      description: 'A helpful AI assistant for coding questions',
    });
    console.log(`✅ Created personality: "${personality.name}" (ID: ${personality.id})`);
    expect(personality.id).toBeString();
    expect(personality.name).toBe('AI Assistant');

    // 2. Create a new chat related to the personality using the new fluent API
    const chat = personality.chats.insert({
      title: 'JavaScript Help Session',
    });
    console.log(`✅ Created chat: "${chat.title}" (ID: ${chat.id})`);
    expect(chat.id).toBeString();
    
    // 3. Verify the 'belongs-to' relationship back to personality
    const parentPersonality = chat.personality();
    expect(parentPersonality.id).toBe(personality.id);
    console.log(`🔗 Chat correctly belongs to personality: "${parentPersonality.name}"`);

    // 4. Add a user message to the chat
    const userMessage = chat.messages.insert({
      content: 'How do I implement a hash table in JavaScript?',
      isUser: true,
    });
    console.log(`👤 User message: "${userMessage.content}"`);
    expect(userMessage.isUser).toBe(true);

    // 5. Create a placeholder for the AI's response
    const aiMessage = chat.messages.insert({
      content: '', // Start with empty content
      isUser: false,
    });
    console.log(`🤖 AI message placeholder created (ID: ${aiMessage.id})`);
    expect(aiMessage.content).toBe('');
    expect(aiMessage.isUser).toBe(false);

    // 6. Simulate the LLM streaming tokens and update the AI message using its own .update() method
    const streamingTokens = ['A hash table', ' in JavaScript', ' can be implemented', ' using a Map.'];
    console.log('\n🚀 Starting LLM streaming response...\n');
    
    let accumulatedContent = '';
    for (const token of streamingTokens) {
        accumulatedContent += token;
        aiMessage.update({ content: accumulatedContent });
    }
    
    // 7. Final state verification
    const finalMessage = db.messages.get({ id: aiMessage.id });
    console.log(`\n✅ Final AI message: "${finalMessage.content}"`);

    expect(finalMessage.content).toBe('A hash table in JavaScript can be implemented using a Map.');
    expect(finalMessage.isUser).toBe(false);
    
    // Verify subscription received all updates
    expect(streamingUpdates).toHaveLength(4);
    expect(streamingUpdates[3].content).toBe(finalMessage.content);

    // 8. Verify relationships and counts using the fluent API
    const finalChat = db.chats.get({ id: chat.id });
    const chatMessages = finalChat.messages.find();
    console.log(`\nChat now has ${chatMessages.length} messages.`);
    expect(chatMessages).toHaveLength(2);
    expect(chatMessages.find(m => m.isUser).content).toBe(userMessage.content);
    expect(chatMessages.find(m => !m.isUser).content).toBe(finalMessage.content);

    const finalPersonality = db.personalities.get({ id: personality.id });
    const personalityChats = finalPersonality.chats.find();
    console.log(`Personality now has ${personalityChats.length} chats.`);
    expect(personalityChats).toHaveLength(1);
    expect(personalityChats[0].id).toBe(chat.id);
  });
});