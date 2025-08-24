import { describe, it, expect } from 'bun:test';
import { SatiDB, z } from '../satidb';

// --- Schemas for LLM Test ---
const PersonalitySchema = z.object({
  name: z.string(),
  description: z.string(),
  chats: z.lazy(() => z.array(ChatSchema)).optional(),
});

const ChatSchema = z.object({
  title: z.string(),
  personality: z.lazy(() => PersonalitySchema).optional(),
  messages: z.lazy(() => z.array(MessageSchema)).optional(),
});

const MessageSchema = z.object({
  content: z.string(),
  isUser: z.boolean(),
  timestamp: z.date().default(() => new Date()),
  chat: z.lazy(() => ChatSchema).optional(),
});

describe('SatiDB - LLM Streaming Scenario', () => {
  // Use the generic `MyDatabase` type and provide the schemas
  const db = new SatiDB(':memory:', {
    personalities: PersonalitySchema,
    chats: ChatSchema,
    messages: MessageSchema,
  });

  it('should demonstrate LLM response generation and streaming updates', () => {
    const streamingUpdates: any[] = [];

    // Correct: Access subscribe directly on db.messages
    db.messages.subscribe('update', (updatedMessage) => {
      console.log(`🤖 LLM Stream Update: "${updatedMessage.content}"`);
      streamingUpdates.push(updatedMessage);
    });

    // Correct: Access insert directly on db.personalities
    const personality = db.personalities.insert({
      name: 'AI Assistant',
      description: 'A helpful AI assistant for coding questions',
    });
    console.log(`✅ Created personality: "${personality.name}" (ID: ${personality.id})`);
    expect(personality.id).toBe(1);
    expect(personality.name).toBe('AI Assistant');

    const chat = personality.chats.push({
      title: 'JavaScript Help Session',
    });
    console.log(`✅ Created chat: "${chat.title}" (ID: ${chat.id})`);
    expect(chat.id).toBe(1);

    // 3. Verify the 'belongs-to' relationship back to personality
    const parentPersonality = chat.personality();
    expect(parentPersonality.id).toBe(personality.id);
    console.log(`🔗 Chat correctly belongs to personality: "${parentPersonality.name}"`);

    // 4. Add a user message to the chat
    const userMessage = chat.messages.push({
      content: 'How do I implement a hash table in JavaScript?',
      isUser: true,
    });
    console.log(`👤 User message: "${userMessage.content}"`);
    expect(userMessage.isUser).toBe(true);

    // 5. Create a placeholder for the AI's response
    const aiMessage = chat.messages.push({
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
    // Correct: Access get directly on db.messages
    const finalMessage = db.messages.get(aiMessage.id);
    console.log(`\n✅ Final AI message: "${finalMessage.content}"`);

    expect(finalMessage.content).toBe('A hash table in JavaScript can be implemented using a Map.');
    expect(finalMessage.isUser).toBe(false);

    // Verify subscription received all updates
    expect(streamingUpdates).toHaveLength(4);
    expect(streamingUpdates[3].content).toBe(finalMessage.content);

    // 8. Verify relationships and counts using the new fluent API
    // Correct: Access get directly on db.chats
    const finalChat = db.chats.get(chat.id);
    // Correct: Use .find() to query the collection
    const chatMessages = finalChat.messages.find();
    console.log(`\nChat now has ${chatMessages.length} messages.`);
    expect(chatMessages).toHaveLength(2);
    expect(chatMessages.find(m => m.isUser).content).toBe(userMessage.content);
    expect(chatMessages.find(m => !m.isUser).content).toBe(finalMessage.content);

    const firstMessageInChat = finalChat.messages.get(userMessage.id);
    expect(firstMessageInChat.content).toBe(userMessage.content);

    // Correct: Access get directly on db.personalities
    const finalPersonality = db.personalities.get(personality.id);
    // Correct: Use .find() to query the collection
    const personalityChats = finalPersonality.chats.find();
    console.log(`Personality now has ${personalityChats.length} chats.`);
    expect(personalityChats).toHaveLength(1);
    expect(personalityChats[0].id).toBe(chat.id);

    // 9. Demonstrate reactive property update
    console.log('\n✨ Testing reactive update...');
    finalMessage.content = 'A Map object is the modern way to create hash tables.';
    console.log(`  -> Changed message content directly on the object.`);

    // Correct: Access get directly on db.messages
    const refetchedMessage = db.messages.get(finalMessage.id);
    console.log(`  -> Re-fetched message content: "${refetchedMessage.content}"`);
    expect(refetchedMessage.content).toBe('A Map object is the modern way to create hash tables.');
    console.log('✅ Reactive update successful!');
  });
});

