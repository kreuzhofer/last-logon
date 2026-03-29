// Content Seeder — populates a player's BBS world with fake community history
// Called when a new PlayerGame is created (during registration).
// Each player gets their own independent set of messages, one-liners, callers, bulletins.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import hjson from 'hjson';
import { getDb } from '../core/database.js';
import { getProjectRoot } from '../core/config.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('content-seeder');

// ─── Types for seed data config ─────────────────────────────────────────────

interface SeedUser {
  handle: string;
  location: string;
  createdAt: string;
  lastLoginAt: string | null;
  role: string;
}

interface SeedMessage {
  areaTag: string;
  fromHandle: string;
  toName: string;
  subject: string;
  body: string;
  daysAgo: number;
  replyToSubject?: string;
}

interface SeedOneLiner {
  handle: string;
  text: string;
  daysAgo: number;
}

interface SeedLastCaller {
  handle: string;
  location: string;
  node: number;
  daysAgo: number;
}

interface SeedBulletin {
  number: number;
  title: string;
  body: string;
}

interface SeedDataConfig {
  users: SeedUser[];
  messages: SeedMessage[];
  messagesExtra?: SeedMessage[];
  oneLiners: SeedOneLiner[];
  lastCallers: SeedLastCaller[];
  bulletins: SeedBulletin[];
}

// ─── Timestamp helpers ──────────────────────────────────────────────────────

function backdatedTimestamp(daysAgo: number): Date {
  const baseMs = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
  let hour: number;
  if (Math.random() < 0.7) {
    const nightHours = [21, 22, 23, 0, 1, 2, 3];
    hour = nightHours[Math.floor(Math.random() * nightHours.length)]!;
  } else {
    hour = 8 + Math.floor(Math.random() * 13);
  }
  const minutes = Math.floor(Math.random() * 60);
  const date = new Date(baseMs);
  date.setHours(hour, minutes, Math.floor(Math.random() * 60), 0);
  return date;
}

// ─── Cache for seed data config ─────────────────────────────────────────────

let cachedConfig: SeedDataConfig | undefined;

function getSeedData(): SeedDataConfig {
  if (cachedConfig) return cachedConfig;
  const configPath = resolve(getProjectRoot(), 'config/last-logon/seed-data.hjson');
  const raw = readFileSync(configPath, 'utf-8');
  cachedConfig = hjson.parse(raw) as SeedDataConfig;
  return cachedConfig;
}

// ─── Per-player seeding ─────────────────────────────────────────────────────

/**
 * Seed a player's BBS world with fake community content.
 * Called once when a new PlayerGame is created during registration.
 * Creates NPC users (if not already existing), then scopes all content
 * to this player's game via playerGameId.
 */
export async function seedPlayerContent(playerGameId: number): Promise<void> {
  const db = getDb();
  const config = getSeedData();

  // 1. Ensure NPC users exist (shared across all games, accessLevel: 0)
  const userMap = new Map<string, number>();
  for (const u of config.users) {
    let user = await db.user.findUnique({ where: { handle: u.handle } });
    if (!user) {
      user = await db.user.create({
        data: {
          handle: u.handle,
          passwordHash: '$argon2id$placeholder',
          accessLevel: 0,
          location: u.location,
          createdAt: new Date(u.createdAt),
          lastLoginAt: u.lastLoginAt ? new Date(u.lastLoginAt) : null,
          totalCalls: Math.floor(Math.random() * 200) + 10,
          totalPosts: 0,
        },
      });
    }
    userMap.set(u.handle, user.id);
  }

  // 2. Create messages scoped to this player's game
  const allMessages = [...config.messages, ...(config.messagesExtra ?? [])];
  const areaCache = new Map<string, number>();
  const messageSubjectMap = new Map<string, number>();

  for (const msg of allMessages) {
    let areaId = areaCache.get(msg.areaTag);
    if (areaId === undefined) {
      const area = await db.messageArea.findUnique({ where: { tag: msg.areaTag } });
      if (!area) {
        log.warn({ areaTag: msg.areaTag }, 'Message area not found, skipping');
        continue;
      }
      areaId = area.id;
      areaCache.set(msg.areaTag, areaId);
    }

    const userId = userMap.get(msg.fromHandle);
    let replyToId: number | null = null;
    if (msg.replyToSubject) {
      const parentKey = `${msg.areaTag}:${msg.replyToSubject}`;
      replyToId = messageSubjectMap.get(parentKey) ?? null;
    }

    const message = await db.message.create({
      data: {
        playerGameId,
        areaId,
        fromUserId: userId ?? null,
        fromName: msg.fromHandle,
        toName: msg.toName,
        subject: msg.subject,
        body: msg.body.trim(),
        replyToId,
        createdAt: backdatedTimestamp(msg.daysAgo),
        origin: 'seed',
      },
    });

    const subjectKey = `${msg.areaTag}:${msg.subject.replace(/^Re: /, '')}`;
    if (!messageSubjectMap.has(subjectKey)) {
      messageSubjectMap.set(subjectKey, message.id);
    }
    messageSubjectMap.set(`${msg.areaTag}:${msg.subject}`, message.id);
  }

  log.info({ playerGameId, count: allMessages.length }, 'Seeded messages');

  // 3. Create one-liners scoped to this player's game
  for (const liner of config.oneLiners) {
    const userId = userMap.get(liner.handle);
    if (!userId) continue;

    await db.oneliner.create({
      data: {
        playerGameId,
        userId,
        handle: liner.handle,
        text: liner.text,
        postedAt: backdatedTimestamp(liner.daysAgo),
      },
    });
  }

  log.info({ playerGameId, count: config.oneLiners.length }, 'Seeded one-liners');

  // 4. Create last callers scoped to this player's game
  for (const caller of config.lastCallers) {
    const userId = userMap.get(caller.handle);
    if (!userId) continue;

    await db.lastCaller.create({
      data: {
        playerGameId,
        userId,
        handle: caller.handle,
        location: caller.location || null,
        node: caller.node,
        loginAt: backdatedTimestamp(caller.daysAgo),
      },
    });
  }

  log.info({ playerGameId, count: config.lastCallers.length }, 'Seeded last callers');

  // 5. Create bulletins scoped to this player's game
  for (const bulletin of config.bulletins) {
    await db.bulletin.create({
      data: {
        playerGameId,
        number: bulletin.number,
        title: bulletin.title,
        body: bulletin.body.trim(),
        active: true,
      },
    });
  }

  log.info({ playerGameId, count: config.bulletins.length }, 'Seeded bulletins');

  log.info({ playerGameId }, 'Player BBS content seeding complete');
}
