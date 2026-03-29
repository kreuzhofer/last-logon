// Message Bridge — injects killer/NPC messages into the BBS message system
// Makes game messages appear as real BBS messages

import { getDb } from '../core/database.js';
import { createChildLogger } from '../core/logger.js';
import { getNPCDef, getNPCDefs } from './base-script-loader.js';
import { getOrCreateNPC, addGameEvent, addStoryLogEntry, createNotification } from './game-layer.js';
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

  // Check if we already injected one-liners for this game
  const existing = await db.oneliner.findFirst({
    where: { handle: ghostDef.handle },
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
        userId: game.userId,
        handle: ghostDef.handle,
        text: lineText,
        postedAt: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000), // Random date in last 30 days
      },
    });
  }

  log.info({ gameId: game.id }, 'Ghost one-liners injected');
}
