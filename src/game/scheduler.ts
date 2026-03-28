// Scheduler — Background job for inactivity messages and async killer actions
// Runs as part of the BBS process, checks periodically for players who need attention

import { getDb } from '../core/database.js';
import { createChildLogger } from '../core/logger.js';
import { buildStoryContext, createNotification } from './game-layer.js';
import { generateAsyncMessage } from './ai-engine.js';
import { sendKillerMessage } from './message-bridge.js';
import type { PlayerGame } from '@prisma/client';

const log = createChildLogger('game-scheduler');

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // Check every hour
const DEFAULT_INACTIVITY_HOURS = 48;

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startGameScheduler(): void {
  if (intervalHandle) return;

  intervalHandle = setInterval(async () => {
    try {
      await checkInactivePlayers();
    } catch (err) {
      log.error({ error: err }, 'Scheduler error');
    }
  }, CHECK_INTERVAL_MS);

  log.info('Game scheduler started');
}

export function stopGameScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    log.info('Game scheduler stopped');
  }
}

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
