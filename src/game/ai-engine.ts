// AI Engine — Vercel AI SDK integration for Last Logon
// Uses Claude via @ai-sdk/anthropic with tool_use for structured responses

import { generateText, tool, jsonSchema } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { createChildLogger } from '../core/logger.js';
import { getDb } from '../core/database.js';
import { getAIPrompt, interpolateTemplate, getKillerPersonality } from './base-script-loader.js';
import type {
  KillerResponse,
  KillerMood,
  StoryContext,
  ConversationMessage,
} from './game-types.js';

const log = createChildLogger('ai-engine');

// ─── Configuration ───────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const MAX_CONVERSATION_WINDOW = 15;
const MAX_TOKENS_PER_RESPONSE = 1024;

function getModel() {
  const modelId = process.env.LAST_LOGON_AI_MODEL ?? DEFAULT_MODEL;
  return anthropic(modelId);
}

// ─── Killer Response Tool Schema ─────────────────────────────────────────────

const killerResponseSchema = z.object({
  text: z.string().describe('The killer\'s response text, may include BBS pipe codes like |11, |08, |15, |12. Max 76 chars per line, 1-4 lines.'),
  mood: z.enum(['charming', 'playful', 'condescending', 'irritated', 'threatening', 'impressed', 'manic']).describe('The killer\'s current mood after this response'),
  beatTriggered: z.string().optional().describe('Story beat tag if this response triggers one'),
  clueRevealed: z.string().optional().describe('Clue tag if a clue is embedded in the response'),
  unlocks: z.array(z.string()).optional().describe('BBS features to unlock for the player'),
  trustDelta: z.number().optional().describe('Change to killer trust level (-20 to +20)'),
  suspicionDelta: z.number().optional().describe('Change to suspicion level (-20 to +20)'),
});

// ─── Build System Prompt ─────────────────────────────────────────────────────

function buildKillerSystemPrompt(context: StoryContext): string {
  const template = getAIPrompt('killerSystemPrompt');
  const personality = getKillerPersonality();

  const vars: Record<string, string | number> = {
    killerAlias: context.killerAlias,
    currentMood: context.killerMood,
    chapter: context.chapter,
    language: context.language === 'de' ? 'German' : 'English',
    cluesFound: context.cluesFound.join(', ') || 'none',
    puzzlesSolved: context.puzzlesSolved.join(', ') || 'none',
    killerTrust: context.suspicionLevel,
    suspicionLevel: context.suspicionLevel,
    totalSessions: context.totalSessions,
    unlockedFeatures: context.unlockedFeatures.join(', ') || 'basic',
    storySummary: context.storySummary || 'No interactions yet.',
    activeNPCs: context.activeNPCs.map(n =>
      `${n.handle} (${n.role}, ${n.relationship}, ${n.status})`
    ).join('; ') || 'none',
  };

  let prompt = interpolateTemplate(template, vars);

  // Add personality traits
  prompt += `\n\n## Personality Traits\n${personality.traits.join(', ')}`;
  prompt += `\n\n## Motivation\n${personality.motivation}`;
  prompt += `\n\n## Communication Style\n${personality.communication}`;

  return prompt;
}

// ─── Load Conversation History ───────────────────────────────────────────────

async function getConversationWindow(userId: number): Promise<ConversationMessage[]> {
  const db = getDb();
  const rows = await db.gameConversation.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: MAX_CONVERSATION_WINDOW,
  });

  return rows.reverse().map(r => ({
    role: r.role as 'user' | 'assistant',
    content: r.content,
  }));
}

async function saveConversation(userId: number, role: 'user' | 'assistant', content: string, metadata?: Record<string, unknown>): Promise<void> {
  const db = getDb();
  await db.gameConversation.create({
    data: {
      userId,
      role,
      content,
      metadata: metadata ? JSON.stringify(metadata) : null,
    },
  });
}

// ─── Core AI Functions ───────────────────────────────────────────────────────

export async function getKillerResponse(
  userId: number,
  playerInput: string,
  context: StoryContext,
): Promise<KillerResponse> {
  const systemPrompt = buildKillerSystemPrompt(context);
  const history = await getConversationWindow(userId);

  // Save player's message
  await saveConversation(userId, 'user', playerInput);

  const messages = [
    ...history.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user' as const, content: playerInput },
  ];

  try {
    const result = await generateText({
      model: getModel(),
      system: systemPrompt,
      messages,
      tools: {
        respond_to_player: tool({
          description: 'Respond to the player as the killer. Always use this tool.',
          parameters: jsonSchema({
            type: 'object' as const,
            properties: {
              text: { type: 'string', description: 'The killer\'s response text, may include BBS pipe codes like |11, |08, |15, |12. Max 76 chars per line, 1-4 lines.' },
              mood: { type: 'string', enum: ['charming', 'playful', 'condescending', 'irritated', 'threatening', 'impressed', 'manic'], description: 'The killer\'s current mood after this response' },
              beatTriggered: { type: 'string', description: 'Story beat tag if this response triggers one' },
              clueRevealed: { type: 'string', description: 'Clue tag if a clue is embedded in the response' },
              unlocks: { type: 'array', items: { type: 'string' }, description: 'BBS features to unlock for the player' },
              trustDelta: { type: 'number', description: 'Change to killer trust level (-20 to +20)' },
              suspicionDelta: { type: 'number', description: 'Change to suspicion level (-20 to +20)' },
            },
            required: ['text', 'mood'],
          }),
          execute: async (params) => params,
        }),
      },
      toolChoice: { type: 'tool', toolName: 'respond_to_player' },
      maxTokens: MAX_TOKENS_PER_RESPONSE,
    });

    // Extract tool call result
    const toolCall = result.toolCalls?.[0];
    if (toolCall && toolCall.toolName === 'respond_to_player') {
      const response = toolCall.args as KillerResponse;

      // Save killer's response
      await saveConversation(userId, 'assistant', response.text, {
        mood: response.mood,
        beatTriggered: response.beatTriggered,
        clueRevealed: response.clueRevealed,
      });

      log.info({ userId, mood: response.mood }, 'Killer response generated');
      return response;
    }

    // Fallback if tool wasn't called (shouldn't happen with toolChoice)
    const fallbackText = result.text || '|08...';
    await saveConversation(userId, 'assistant', fallbackText);
    return {
      text: fallbackText,
      mood: context.killerMood,
    };
  } catch (err) {
    log.error({ error: err, userId }, 'AI call failed');
    // Return in-character fallback
    const fallback: KillerResponse = {
      text: context.language === 'de'
        ? '|08[Verbindung instabil... versuche erneut]'
        : '|08[Connection unstable... try again]',
      mood: context.killerMood,
    };
    await saveConversation(userId, 'assistant', fallback.text);
    return fallback;
  }
}

export async function generateAsyncMessage(
  userId: number,
  trigger: string,
  context: StoryContext,
): Promise<string> {
  const systemPrompt = buildKillerSystemPrompt(context);
  const triggerPrompt = context.language === 'de'
    ? `Generiere eine kurze, beunruhigende Nachricht an den Spieler. Grund: ${trigger}. Maximal 3 Zeilen.`
    : `Generate a short, unsettling message to the player. Reason: ${trigger}. Maximum 3 lines.`;

  try {
    const result = await generateText({
      model: getModel(),
      system: systemPrompt,
      messages: [{ role: 'user', content: triggerPrompt }],
      maxTokens: 256,
    });

    const text = result.text || (context.language === 'de' ? '|12Ich warte.|08' : '|12I\'m waiting.|08');
    await saveConversation(userId, 'assistant', text, { trigger, async: true });
    return text;
  } catch (err) {
    log.error({ error: err, userId, trigger }, 'Async message generation failed');
    return context.language === 'de' ? '|12...|08' : '|12...|08';
  }
}

export async function generatePuzzleHint(
  userId: number,
  puzzleTag: string,
  puzzleDescription: string,
  attempts: number,
  hintsUsed: number,
  context: StoryContext,
): Promise<string> {
  const template = getAIPrompt('puzzleHintPrompt');
  const prompt = interpolateTemplate(template, {
    puzzleTag,
    puzzleDescription,
    attempts,
    hintsUsed,
    language: context.language === 'de' ? 'German' : 'English',
    killerAlias: context.killerAlias,
  });

  try {
    const result = await generateText({
      model: getModel(),
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 256,
    });
    return result.text || '|08No hint available.';
  } catch (err) {
    log.error({ error: err, userId, puzzleTag }, 'Hint generation failed');
    return context.language === 'de' ? '|08Kein Hinweis verfügbar.' : '|08No hint available.';
  }
}

export async function evaluateFreeFormAnswer(
  userId: number,
  puzzleTag: string,
  puzzleType: string,
  playerAnswer: string,
  context: StoryContext,
): Promise<{ correct: boolean; feedback: string; partialCredit: boolean }> {
  const template = getAIPrompt('evaluateAnswerPrompt');
  const prompt = interpolateTemplate(template, {
    puzzleTag,
    puzzleType,
    answerCriteria: `Based on the story context and clues found: ${context.cluesFound.join(', ')}`,
    playerAnswer,
    language: context.language === 'de' ? 'German' : 'English',
    storyContext: context.storySummary,
    killerAlias: context.killerAlias,
  });

  try {
    const result = await generateText({
      model: getModel(),
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 256,
    });

    // Try to parse JSON from the response
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { correct: boolean; feedback: string; partialCredit?: boolean };
      return {
        correct: parsed.correct ?? false,
        feedback: parsed.feedback ?? '',
        partialCredit: parsed.partialCredit ?? false,
      };
    }

    return { correct: false, feedback: result.text, partialCredit: false };
  } catch (err) {
    log.error({ error: err, userId, puzzleTag }, 'Answer evaluation failed');
    return {
      correct: false,
      feedback: context.language === 'de' ? '|08Auswertung fehlgeschlagen. Versuche es erneut.' : '|08Evaluation failed. Try again.',
      partialCredit: false,
    };
  }
}

export async function summarizeConversation(
  userId: number,
  context: StoryContext,
): Promise<string> {
  const db = getDb();
  const conversations = await db.gameConversation.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  if (conversations.length < 10) {
    return context.storySummary; // Not enough to summarize yet
  }

  const template = getAIPrompt('summarizePrompt');
  const prompt = interpolateTemplate(template, {
    killerAlias: context.killerAlias,
  });

  const conversationText = conversations.map(c =>
    `[${c.role}]: ${c.content}`
  ).join('\n');

  try {
    const result = await generateText({
      model: getModel(),
      messages: [{ role: 'user', content: `${prompt}\n\n${conversationText}` }],
      maxTokens: 512,
    });
    return result.text;
  } catch (err) {
    log.error({ error: err, userId }, 'Summarization failed');
    return context.storySummary;
  }
}

// ─── NPC Board Post Generation ──────────────────────────────────────────────

const HAIKU_MODEL = 'claude-haiku-4-20250414';
const MAX_NPC_POST_TOKENS = 200;

function getHaikuModel() {
  return anthropic(HAIKU_MODEL);
}

export interface NPCPostResult {
  text: string;
  subject: string;
}

export async function generateNPCPost(
  userId: number,
  npcHandle: string,
  areaTag: string,
  threadSubject: string,
  recentMessages: Array<{ from: string; body: string }>,
  context: {
    npcPersonality: string;
    npcRole: string;
    chapter: string;
    language: string;
    playerHandle: string;
  },
): Promise<NPCPostResult> {
  const npcPromptTemplate = getAIPrompt('npcBoardPostPrompt');

  const recentText = recentMessages
    .slice(-5)
    .map(m => `[${m.from}]: ${m.body}`)
    .join('\n\n');

  const vars: Record<string, string | number> = {
    npcHandle,
    npcPersonality: context.npcPersonality,
    npcRole: context.npcRole,
    areaTag,
    threadSubject,
    recentMessages: recentText,
    chapter: context.chapter,
    language: context.language === 'de' ? 'German' : 'English',
    playerHandle: context.playerHandle,
  };

  const systemPrompt = interpolateTemplate(npcPromptTemplate, vars);

  try {
    const result = await generateText({
      model: getHaikuModel(),
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: context.language === 'de'
          ? `Schreibe eine kurze Antwort als ${npcHandle} auf den Thread "${threadSubject}" im ${areaTag} Board.`
          : `Write a short reply as ${npcHandle} to the thread "${threadSubject}" in the ${areaTag} board.`,
      }],
      maxTokens: MAX_NPC_POST_TOKENS,
    });

    const text = result.text || `— ${npcHandle}`;

    // Generate a reply subject (keep original subject with Re: prefix if not already)
    const subject = threadSubject.startsWith('Re: ')
      ? threadSubject
      : `Re: ${threadSubject}`;

    log.info({ userId, npcHandle, areaTag, subject }, 'NPC board post generated');
    return { text, subject };
  } catch (err) {
    log.error({ error: err, userId, npcHandle }, 'NPC board post generation failed');
    // Return a fallback in-character response
    return {
      text: `— ${npcHandle}`,
      subject: threadSubject.startsWith('Re: ') ? threadSubject : `Re: ${threadSubject}`,
    };
  }
}

// ─── Exports for testing ─────────────────────────────────────────────────────

export { buildKillerSystemPrompt as _buildKillerSystemPrompt };
export { killerResponseSchema as _killerResponseSchema };
