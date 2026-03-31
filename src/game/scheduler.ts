// Scheduler — Background job for inactivity messages, async killer actions, and NPC responses
// Runs as part of the BBS process, checks periodically for players who need attention

import { getDb } from '../core/database.js';
import { createChildLogger } from '../core/logger.js';
import { buildStoryContext, createNotification, getStoryThreads } from './game-layer.js';
import { generateAsyncMessage } from './ai-engine.js';
import { sendKillerMessage, generateAndPostNPCResponse } from './message-bridge.js';
import { postMessage } from '../messages/message-service.js';
import type { PlayerGame } from '@prisma/client';

const log = createChildLogger('game-scheduler');

const CHECK_INTERVAL_MS = 3 * 60 * 1000;  // Check every 3 minutes for responsive feel
const INACTIVITY_CHECK_INTERVAL_MS = 60 * 60 * 1000;  // Inactivity check every hour
const DEFAULT_INACTIVITY_HOURS = 48;
const NPC_RESPONSE_COOLDOWN_MS = 15 * 60 * 1000;  // 15 minutes between NPC responses per player
const RECENT_MESSAGE_WINDOW_MS = 60 * 60 * 1000;  // Look back 1 hour for player messages

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let lastInactivityCheck = 0;

export function startGameScheduler(): void {
  if (intervalHandle) return;

  intervalHandle = setInterval(async () => {
    try {
      // Check for mail to AXIOM that needs a reply
      await checkForAxiomMailReplies();

      // Run NPC response checks on every tick
      await checkForNPCResponses();

      // Run inactivity checks less frequently (every hour)
      const now = Date.now();
      if (now - lastInactivityCheck >= INACTIVITY_CHECK_INTERVAL_MS) {
        await checkInactivePlayers();
        lastInactivityCheck = now;
      }
    } catch (err) {
      log.error({ error: err }, 'Scheduler error');
    }
  }, CHECK_INTERVAL_MS);

  lastInactivityCheck = Date.now();
  log.info('Game scheduler started (3-minute interval)');
}

export function stopGameScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    log.info('Game scheduler stopped');
  }
}

// ─── NPC Response Checking ──────────────────────────────────────────────────

/**
 * Compute the player's current local hour from their stored timezone.
 * Falls back to UTC hour if timezone is invalid.
 */
function getPlayerLocalHour(timezone: string): number {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const hourPart = parts.find(p => p.type === 'hour');
    return hourPart ? parseInt(hourPart.value, 10) : now.getUTCHours();
  } catch {
    return new Date().getUTCHours();
  }
}

/**
 * Determine whether an NPC should respond, based on time of day in the
 * player's timezone. Returns true if the RNG says yes.
 *
 * Evening/night (18:00-03:00): 70% chance
 * Daytime (06:00-18:00): 30% chance
 * Early morning (03:00-06:00): 10% chance
 */
function shouldNPCRespond(playerHour: number): boolean {
  let probability: number;

  if (playerHour >= 18 || playerHour < 3) {
    probability = 0.9;  // Evening/night — almost always respond
  } else if (playerHour >= 6 && playerHour < 18) {
    probability = 0.6;  // Daytime — more than half the time
  } else {
    probability = 0.3;  // Early morning
  }

  const roll = Math.random();
  log.info({ playerHour, probability, roll, respond: roll < probability }, 'NPC response RNG');
  return roll < probability;
}

/**
 * Check for player messages that deserve NPC responses.
 * Runs every 10 minutes via the scheduler.
 */
async function checkForNPCResponses(): Promise<void> {
  const db = getDb();
  const lookbackTime = new Date(Date.now() - RECENT_MESSAGE_WINDOW_MS);

  // Find active games (not completed, not prologue) that have users
  const activeGames = await db.playerGame.findMany({
    where: {
      phase: { not: 'prologue' },
      chapter: { notIn: ['chapter5_caught', 'chapter5_escaped', 'complete'] },
    },
    include: { user: true },
  });

  for (const game of activeGames) {
    try {
      await processGameForNPCResponse(game as PlayerGame & { user: { handle: string; id: number } }, lookbackTime);
    } catch (err) {
      log.error({ error: err, gameId: game.id }, 'Failed to process game for NPC response');
    }
  }
}

/**
 * Process a single game to check if the player deserves an NPC response.
 */
async function processGameForNPCResponse(
  game: PlayerGame & { user: { handle: string; id: number } },
  recentThreshold: Date,
): Promise<void> {
  const db = getDb();

  // Check NPC response cooldown — no more than 1 NPC response per player per 30 min
  const storyThreads = getStoryThreads(game);
  if (storyThreads.lastNPCResponseAt) {
    const lastResponse = new Date(storyThreads.lastNPCResponseAt).getTime();
    if (Date.now() - lastResponse < NPC_RESPONSE_COOLDOWN_MS) {
      return; // Still in cooldown
    }
  }

  // Find player messages posted in the last 30 minutes on public boards
  // (not in mail.personal or lastlogon.private — those are private channels)
  const recentPlayerMessages = await db.message.findMany({
    where: {
      playerGameId: game.id,
      fromUserId: game.userId,
      createdAt: { gte: recentThreshold },
      area: {
        tag: { notIn: ['mail.personal', 'lastlogon.private'] },
      },
    },
    include: {
      area: { select: { tag: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });

  if (recentPlayerMessages.length === 0) {
    log.debug({ gameId: game.id }, 'No recent player messages on public boards');
    return;
  }

  log.info({ gameId: game.id, messageCount: recentPlayerMessages.length, latestSubject: recentPlayerMessages[0]?.subject }, 'Found recent player messages');

  // Get the player's local hour for probability + NPC selection
  const playerHour = getPlayerLocalHour(game.timezone);

  // RNG: should an NPC respond?
  if (!shouldNPCRespond(playerHour)) {
    log.debug({ gameId: game.id, playerHour }, 'NPC response RNG says no');
    return;
  }

  // Pick the most recent player message to respond to
  const targetMessage = recentPlayerMessages[0];

  // Check if an NPC already responded to this exact message
  const existingNPCReply = await db.message.findFirst({
    where: {
      playerGameId: game.id,
      replyToId: targetMessage.id,
      fromUserId: null, // NPC messages have no real user ID
    },
  });
  if (existingNPCReply) {
    return; // Already responded to this message
  }

  // Generate and post the NPC response
  const success = await generateAndPostNPCResponse(
    game,
    {
      areaTag: targetMessage.area.tag,
      areaId: targetMessage.areaId,
      subject: targetMessage.subject,
      body: targetMessage.body,
      replyToId: targetMessage.replyToId,
      messageId: targetMessage.id,
    },
    playerHour,
  );

  if (success) {
    log.info({ gameId: game.id, messageId: targetMessage.id, playerHour }, 'NPC response posted');
  }
}

// ─── AXIOM Mail Reply System ─────────────────────────────────────────────────

/**
 * Check for player mail addressed to AXIOM that hasn't been answered.
 * Generates an AI response and sends it as a mail reply.
 */
async function checkForAxiomMailReplies(): Promise<void> {
  const db = getDb();

  // Find active games
  const activeGames = await db.playerGame.findMany({
    where: {
      chapter: { notIn: ['complete'] },
    },
    include: { user: true },
  });

  for (const game of activeGames) {
    try {
      // Find mail area
      const mailArea = await db.messageArea.findUnique({ where: { tag: 'mail.personal' } });
      if (!mailArea) continue;

      // Find player's mail to AXIOM that hasn't been replied to
      const playerMailToAxiom = await db.message.findMany({
        where: {
          playerGameId: game.id,
          areaId: mailArea.id,
          fromUserId: game.userId,
          toName: game.killerAlias,
        },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });

      if (playerMailToAxiom.length === 0) continue;

      const lastMail = playerMailToAxiom[0]!;

      // Check if AXIOM already replied to this message
      const axiomReply = await db.message.findFirst({
        where: {
          playerGameId: game.id,
          areaId: mailArea.id,
          fromName: game.killerAlias,
          createdAt: { gt: lastMail.createdAt },
        },
      });

      if (axiomReply) continue; // Already replied

      // Generate AI response via the killer chat engine
      const { getKillerResponse } = await import('./ai-engine.js');
      const { buildStoryContext } = await import('./game-layer.js');
      const context = await buildStoryContext(game);

      const response = await getKillerResponse(game.userId, lastMail.body, context);

      // Send AXIOM's reply as mail
      await postMessage(
        game.id,
        mailArea.id,
        null,
        game.killerAlias,
        lastMail.subject.startsWith('Re: ') ? lastMail.subject : `Re: ${lastMail.subject}`,
        response.text.replace(/\|(\d{2})/g, ''), // Strip pipe codes for mail
        { toName: (game as any).user.handle, replyToId: lastMail.id },
      );

      // Apply AI response effects
      const { applyKillerResponseEffects } = await import('./game-layer.js');
      await applyKillerResponseEffects(game, response);

      // Notify player
      await createNotification(game.userId, 'message', `Reply from ${game.killerAlias}`);

      log.info({ gameId: game.id, subject: lastMail.subject }, 'AXIOM mail reply sent');
    } catch (err) {
      log.error({ error: err, gameId: game.id }, 'Failed to generate AXIOM mail reply');
    }
  }
}

// ─── Inactivity Checking ────────────────────────────────────────────────────

async function checkInactivePlayers(): Promise<void> {
  const db = getDb();
  const inactivityThreshold = new Date(Date.now() - DEFAULT_INACTIVITY_HOURS * 60 * 60 * 1000);

  const inactivePlayers = await db.playerGame.findMany({
    where: {
      lastActivity: { lt: inactivityThreshold },
      phase: { not: 'prologue' }, // Don't bother players who haven't really started
      chapter: { notIn: ['chapter5_caught', 'chapter5_escaped', 'complete'] },
    },
    include: { user: true },
  });

  for (const game of inactivePlayers) {
    // Don't send more than one reminder per inactivity period
    const lastNotif = await db.gameNotification.findFirst({
      where: { userId: game.userId, type: 'inactivity' },
      orderBy: { createdAt: 'desc' },
    });

    if (lastNotif && lastNotif.createdAt > inactivityThreshold) continue;

    try {
      const context = await buildStoryContext(game);
      const hoursSinceActivity = Math.floor((Date.now() - game.lastActivity.getTime()) / 3600000);

      let trigger: string;
      if (hoursSinceActivity > 168) { // > 1 week
        trigger = 'long_absence';
      } else if (hoursSinceActivity > 72) {
        trigger = 'medium_absence';
      } else {
        trigger = 'short_absence';
      }

      // Generate killer message via AI
      const message = await generateAsyncMessage(game.userId, trigger, context);

      // Send as BBS message
      const subject = context.language === 'de'
        ? 'Wo bist du?'
        : 'Where are you?';
      await sendKillerMessage(game, subject, message, game.user.handle);

      // Also create a notification
      await createNotification(
        game.userId,
        'inactivity',
        context.language === 'de'
          ? `${game.killerAlias} hat dir eine Nachricht hinterlassen...`
          : `${game.killerAlias} left you a message...`,
      );

      log.info({ userId: game.userId, trigger, hours: hoursSinceActivity }, 'Inactivity message sent');
    } catch (err) {
      log.error({ error: err, userId: game.userId }, 'Failed to send inactivity message');
    }
  }
}

// Export for testing
export { checkInactivePlayers as _checkInactivePlayers };
export { checkForNPCResponses as _checkForNPCResponses };
export { getPlayerLocalHour as _getPlayerLocalHour };
export { shouldNPCRespond as _shouldNPCRespond };
