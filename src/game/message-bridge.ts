// Message Bridge — injects killer/NPC messages into the BBS message system
// Makes game messages appear as real BBS messages

import { getDb } from '../core/database.js';
import { createChildLogger } from '../core/logger.js';
import { getNPCDef, getNPCDefs } from './base-script-loader.js';
import { getOrCreateNPC, addGameEvent, addStoryLogEntry, createNotification, getStoryThreads, updateStoryThreads } from './game-layer.js';
import type { StoryThread, StoryThreads } from './game-layer.js';
import { generateNPCPost } from './ai-engine.js';
import { postMessage, getAreaByTag } from '../messages/message-service.js';
import type { PlayerGame, GameNPC } from '@prisma/client';
import type { StoryContext } from './game-types.js';

const log = createChildLogger('message-bridge');

// ─── Message Area Management ─────────────────────────────────────────────────

const GAME_MESSAGE_AREA_TAG = 'lastlogon.private';
const GAME_ORIGIN = 'game';

async function getOrCreateGameMessageArea(): Promise<number> {
  const db = getDb();

  // Check if area exists
  let area = await db.messageArea.findUnique({ where: { tag: GAME_MESSAGE_AREA_TAG } });
  if (area) return area.id;

  // Create conference first if needed
  let conference = await db.messageConference.findUnique({ where: { tag: 'lastlogon' } });
  if (!conference) {
    conference = await db.messageConference.create({
      data: {
        tag: 'lastlogon',
        name: 'Last Logon',
        description: 'Private game messages',
        sortOrder: 99,
        minAccessLevel: 20,
      },
    });
  }

  // Create area
  area = await db.messageArea.create({
    data: {
      conferenceId: conference.id,
      tag: GAME_MESSAGE_AREA_TAG,
      name: 'Private Messages',
      description: 'Direct messages',
      sortOrder: 0,
      minReadLevel: 20,
      minWriteLevel: 255, // Only system can write
    },
  });

  return area.id;
}

// ─── Send Game Messages ──────────────────────────────────────────────────────

export async function sendKillerMessage(
  game: PlayerGame,
  subject: string,
  body: string,
  playerHandle: string,
): Promise<void> {
  const db = getDb();
  const areaId = await getOrCreateGameMessageArea();

  await db.message.create({
    data: {
      playerGameId: game.id,
      areaId,
      fromName: game.killerAlias,
      toName: playerHandle,
      subject,
      body,
      origin: GAME_ORIGIN,
      originId: `killer-${game.id}-${Date.now()}`,
    },
  });

  await createNotification(game.userId, 'message', `New message from ${game.killerAlias}`);
  await addGameEvent(game, 'killer_message', `Killer sent message: ${subject}`, { subject }, 6);
  log.info({ gameId: game.id, subject }, 'Killer message sent');
}

export async function sendNPCMessage(
  game: PlayerGame,
  npcHandle: string,
  subject: string,
  body: string,
  playerHandle: string,
): Promise<void> {
  const db = getDb();
  const areaId = await getOrCreateGameMessageArea();

  await db.message.create({
    data: {
      playerGameId: game.id,
      areaId,
      fromName: npcHandle,
      toName: playerHandle,
      subject,
      body,
      origin: GAME_ORIGIN,
      originId: `npc-${npcHandle}-${game.id}-${Date.now()}`,
    },
  });

  await createNotification(game.userId, 'message', `New message from ${npcHandle}`);
  await addGameEvent(game, 'npc_message', `NPC ${npcHandle} sent message: ${subject}`, { npcHandle, subject }, 5);
  log.info({ gameId: game.id, npcHandle, subject }, 'NPC message sent');
}

// ─── Get Game Messages for Player ────────────────────────────────────────────

export async function getGameMessages(
  userId: number,
  playerHandle: string,
  limit: number = 20,
): Promise<Array<{
  id: number;
  from: string;
  to: string;
  subject: string;
  body: string;
  createdAt: Date;
}>> {
  const db = getDb();
  const area = await db.messageArea.findUnique({ where: { tag: GAME_MESSAGE_AREA_TAG } });
  if (!area) return [];

  const messages = await db.message.findMany({
    where: {
      areaId: area.id,
      origin: GAME_ORIGIN,
      toName: playerHandle,
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return messages.map(m => ({
    id: m.id,
    from: m.fromName,
    to: m.toName,
    subject: m.subject,
    body: m.body,
    createdAt: m.createdAt,
  }));
}

export async function getUnreadGameMessageCount(userId: number, playerHandle: string): Promise<number> {
  const db = getDb();
  const area = await db.messageArea.findUnique({ where: { tag: GAME_MESSAGE_AREA_TAG } });
  if (!area) return 0;

  // Get last read message id for this user/area
  const readState = await db.messageRead.findUnique({
    where: { userId_areaId: { userId, areaId: area.id } },
  });
  const lastReadId = readState?.lastReadId ?? 0;

  return db.message.count({
    where: {
      areaId: area.id,
      origin: GAME_ORIGIN,
      toName: playerHandle,
      id: { gt: lastReadId },
    },
  });
}

// ─── Seed Initial NPC Messages Based on Triggers ─────────────────────────────

export async function checkAndSendNPCMessages(
  game: PlayerGame,
  playerHandle: string,
  context: StoryContext,
): Promise<void> {
  const npcDefs = getNPCDefs();

  for (const npcDef of npcDefs) {
    if (!npcDef.initialMessages?.length) continue;

    for (const msg of npcDef.initialMessages) {
      const trigger = msg.trigger;
      if (!trigger) continue;

      // Check if this message was already sent (using originId pattern)
      const db = getDb();
      const existing = await db.message.findFirst({
        where: {
          origin: GAME_ORIGIN,
          originId: { startsWith: `npc-${npcDef.handle}-${game.id}-init-${msg.subject.substring(0, 20)}` },
        },
      });
      if (existing) continue;

      // Check trigger conditions
      let triggered = false;
      switch (trigger.type) {
        case 'login_count':
          triggered = game.totalSessions >= (trigger.min ?? 1);
          break;
        case 'clue_found':
          triggered = context.cluesFound.includes(trigger.clue ?? '');
          break;
        case 'puzzle_solved':
          triggered = context.puzzlesSolved.includes(trigger.puzzle ?? '');
          break;
        case 'interaction_count':
          triggered = game.totalInteractions >= (trigger.min ?? 1);
          break;
      }

      if (triggered) {
        // Ensure NPC exists in game
        await getOrCreateNPC(game, npcDef.tag);

        const body = (game.language === 'de' && msg.bodyDe) ? msg.bodyDe : msg.body;

        const areaId = await getOrCreateGameMessageArea();
        await db.message.create({
          data: {
            playerGameId: game.id,
            areaId,
            fromName: npcDef.handle,
            toName: playerHandle,
            subject: msg.subject,
            body,
            origin: GAME_ORIGIN,
            originId: `npc-${npcDef.handle}-${game.id}-init-${msg.subject.substring(0, 20)}`,
          },
        });

        await createNotification(game.userId, 'message', `New message from ${npcDef.handle}`);
        await addGameEvent(game, 'npc_message', `NPC ${npcDef.handle}: ${msg.subject}`, { npcHandle: npcDef.handle }, 6);
        log.info({ gameId: game.id, npc: npcDef.handle, subject: msg.subject }, 'NPC initial message sent');
      }
    }
  }
}

// ─── One-liner Injection (ghost user) ────────────────────────────────────────

export async function injectGhostOneLiners(game: PlayerGame): Promise<void> {
  const db = getDb();
  const ghostDef = getNPCDef('ghost_user');
  if (!ghostDef || !ghostDef.oneLiners?.length) return;

  // Check if we already injected one-liners for this player's game
  const existing = await db.oneliner.findFirst({
    where: { playerGameId: game.id, handle: ghostDef.handle },
  });
  if (existing) return;

  // Pick 2-3 random one-liners
  const shuffled = [...ghostDef.oneLiners].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, Math.min(3, shuffled.length));

  for (const text of selected) {
    const lineText = game.language === 'de' && ghostDef.oneLinersDE?.length
      ? ghostDef.oneLinersDE[ghostDef.oneLiners.indexOf(text)] ?? text
      : text;

    await db.oneliner.create({
      data: {
        playerGameId: game.id,
        userId: game.userId,
        handle: ghostDef.handle,
        text: lineText,
        postedAt: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000),
      },
    });
  }

  log.info({ gameId: game.id }, 'Ghost one-liners injected');
}

// ─── NPC Topic Matching ───────────────────────────────────────────────────────

interface NPCTopicMapping {
  handle: string;
  areaTags: string[];
  keywords: string[];
  personality: string;
  role: string;
}

const NPC_TOPIC_MAP: NPCTopicMapping[] = [
  {
    handle: 'NIGHTOWL',
    areaTags: ['local.general', 'retro.bbs'],
    keywords: ['night', 'late', 'sleep', 'insomnia', 'midnight', 'community', 'board', 'bbs'],
    personality: 'Friendly night owl. Been on the BBS for years. Nostalgic about the early days. Talks about other users fondly. Posts late at night. Warm and welcoming.',
    role: 'fellow_user — longtime BBS regular, night shift worker, always online past midnight',
  },
  {
    handle: 'BYTE_RUNNER',
    areaTags: ['retro.hardware', 'retro.software', 'local.general'],
    keywords: ['hardware', 'computer', 'vintage', 'retro', 'commodore', 'amiga', 'modem', 'cpu', 'chip', 'build', 'repair', 'machine'],
    personality: 'Enthusiastic retro computing nerd. Gets excited about old hardware. Uses lots of exclamation marks. Friendly and helpful. Always working on some project.',
    role: 'fellow_user — enthusiastic hardware tinkerer, always building or restoring something',
  },
  {
    handle: 'NEON_PULSE',
    areaTags: ['tech.programming', 'tech.ai', 'local.general'],
    keywords: ['code', 'programming', 'language', 'rust', 'python', 'javascript', 'ai', 'neural', 'algorithm', 'software', 'linux', 'open source'],
    personality: 'Bilingual poster from Berlin. Sometimes mixes German words into English posts when excited. Into modern tech but appreciates retro aesthetics. Thoughtful and analytical.',
    role: 'fellow_user — Berlin-based programmer, bilingual, bridges old and new tech',
  },
  {
    handle: 'DARK_MATTER',
    areaTags: ['retro.bbs', 'local.general', 'local.sysop'],
    keywords: ['philosophy', 'meaning', 'history', 'culture', 'society', 'time', 'memory', 'death', 'change', 'old', 'remember', 'bbs', 'scene'],
    personality: 'Old-timer who has been on BBSes since the 1990s. Philosophical and sometimes melancholic. Speaks from experience. Has seen many users and boards come and go. Dry wit.',
    role: 'fellow_user — BBS old-timer, philosophical, seen everything, sometimes eerily perceptive',
  },
  {
    handle: 'CIRCUIT_JANE',
    areaTags: ['retro.software', 'tech.programming', 'local.general'],
    keywords: ['game', 'software', 'demo', 'graphics', 'sound', 'music', 'tracker', 'demoscene', 'dos', 'windows', 'mac', 'app'],
    personality: 'Sporadic poster with dry humor. Retro software expert. Comes and goes unpredictably. Brief, sometimes cryptic responses. Knows obscure software trivia.',
    role: 'fellow_user — retro software expert, dry humor, posts infrequently but always has something interesting to say',
  },
];

/**
 * Pick which NPC should respond to a post based on area, content, and time of day.
 * Returns null if no NPC is a good match.
 */
function pickRespondingNPC(
  areaTag: string,
  messageBody: string,
  messageSubject: string,
  playerHourLocal: number,
): NPCTopicMapping | null {
  const textLower = `${messageSubject} ${messageBody}`.toLowerCase();

  // Score each NPC based on area match + keyword match
  const scored = NPC_TOPIC_MAP.map(npc => {
    let score = 0;

    // Area match bonus
    if (npc.areaTags.includes(areaTag)) {
      score += 3;
    }

    // Keyword match
    for (const kw of npc.keywords) {
      if (textLower.includes(kw)) {
        score += 1;
      }
    }

    // NIGHTOWL gets a bonus for late-night posts (18:00-03:00)
    if (npc.handle === 'NIGHTOWL' && (playerHourLocal >= 18 || playerHourLocal < 3)) {
      score += 2;
    }

    // NEON_PULSE gets a bonus for morning posts (European timezone alignment)
    if (npc.handle === 'NEON_PULSE' && playerHourLocal >= 6 && playerHourLocal <= 14) {
      score += 1;
    }

    return { npc, score };
  });

  // Filter out zero-score NPCs and sort by score descending
  const viable = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  if (viable.length === 0) {
    // Fall back to NIGHTOWL for general posts — they respond to anything
    return NPC_TOPIC_MAP.find(n => n.handle === 'NIGHTOWL') ?? null;
  }

  // Pick from top candidates with some randomness
  // 60% chance to pick the top scorer, 40% chance to pick a random top-3
  if (viable.length > 1 && Math.random() < 0.4) {
    const topN = viable.slice(0, Math.min(3, viable.length));
    return topN[Math.floor(Math.random() * topN.length)].npc;
  }

  return viable[0].npc;
}

/**
 * Generate and post an NPC response to a player's message on a public board.
 * This is the main entry point for the scheduler to create NPC ambient posts.
 */
export async function generateAndPostNPCResponse(
  game: PlayerGame & { user: { handle: string } },
  playerMessage: {
    areaTag: string;
    areaId: number;
    subject: string;
    body: string;
    replyToId: number | null;
    messageId: number;
  },
  playerHourLocal: number,
): Promise<boolean> {
  const db = getDb();

  // Pick which NPC should respond
  const npc = pickRespondingNPC(
    playerMessage.areaTag,
    playerMessage.body,
    playerMessage.subject,
    playerHourLocal,
  );
  if (!npc) {
    log.debug({ gameId: game.id }, 'No suitable NPC found for response');
    return false;
  }

  // Get recent messages in the thread for context
  const recentMessages = await db.message.findMany({
    where: {
      playerGameId: game.id,
      areaId: playerMessage.areaId,
      OR: [
        { subject: playerMessage.subject },
        { subject: playerMessage.subject.replace(/^Re: /, '') },
        { subject: `Re: ${playerMessage.subject.replace(/^Re: /, '')}` },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { fromName: true, body: true },
  });

  const messagesForContext = recentMessages.reverse().map(m => ({
    from: m.fromName,
    body: m.body,
  }));

  // Generate AI response
  const result = await generateNPCPost(
    game.userId,
    npc.handle,
    playerMessage.areaTag,
    playerMessage.subject,
    messagesForContext,
    {
      npcPersonality: npc.personality,
      npcRole: npc.role,
      chapter: game.chapter,
      language: game.language,
      playerHandle: game.user.handle,
    },
  );

  // Post the NPC's message in the same area via the standard message system
  await postMessage(
    game.id,
    playerMessage.areaId,
    null,                    // No real user ID for NPCs
    npc.handle,
    result.subject,
    result.text,
    {
      toName: 'All',
      replyToId: playerMessage.messageId,
    },
  );

  // Create a notification so the player knows there's new activity
  await createNotification(
    game.userId,
    'npc_board_post',
    `New post from ${npc.handle} in ${playerMessage.areaTag}`,
  );

  // Track in story threads
  const threads = getStoryThreads(game);
  const baseSubject = playerMessage.subject.replace(/^Re: /, '');
  let thread = threads.threads.find(
    t => t.areaTag === playerMessage.areaTag && t.subject === baseSubject,
  );
  if (!thread) {
    thread = {
      areaTag: playerMessage.areaTag,
      subject: baseSubject,
      npcHandles: [],
      hintsDropped: [],
      playerPostCount: 1,
      lastNPCResponseAt: new Date().toISOString(),
      lastPlayerPostAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    threads.threads.push(thread);
  }
  if (!thread.npcHandles.includes(npc.handle)) {
    thread.npcHandles.push(npc.handle);
  }
  thread.lastNPCResponseAt = new Date().toISOString();
  threads.lastNPCResponseAt = new Date().toISOString();

  // Trim old threads (keep last 20)
  if (threads.threads.length > 20) {
    threads.threads = threads.threads
      .sort((a, b) => new Date(b.lastNPCResponseAt).getTime() - new Date(a.lastNPCResponseAt).getTime())
      .slice(0, 20);
  }

  await updateStoryThreads(game, threads);

  // Log the event
  await addGameEvent(
    game,
    'npc_board_post',
    `${npc.handle} responded to "${baseSubject}" in ${playerMessage.areaTag}`,
    { npcHandle: npc.handle, areaTag: playerMessage.areaTag, subject: baseSubject },
    4,
  );

  log.info({
    gameId: game.id,
    npcHandle: npc.handle,
    areaTag: playerMessage.areaTag,
    subject: result.subject,
  }, 'NPC board post created');

  return true;
}
