// Content Seeder — populates the BBS with fake users, messages, one-liners,
// last callers, and bulletins to make the board feel alive from day one.
// All seed users have accessLevel: 0 (locked) so they can never log in.

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

/**
 * Generate a backdated timestamp with nighttime bias.
 * 70% of the time, the hour is between 21:00 and 03:00.
 */
function backdatedTimestamp(daysAgo: number): Date {
  const baseMs = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
  let hour: number;
  if (Math.random() < 0.7) {
    // Nighttime: 21-23 or 0-3
    const nightHours = [21, 22, 23, 0, 1, 2, 3];
    hour = nightHours[Math.floor(Math.random() * nightHours.length)]!;
  } else {
    // Daytime: 8-20
    hour = 8 + Math.floor(Math.random() * 13);
  }
  const minutes = Math.floor(Math.random() * 60);
  const date = new Date(baseMs);
  date.setHours(hour, minutes, Math.floor(Math.random() * 60), 0);
  return date;
}

// ─── Main seeder function ───────────────────────────────────────────────────

export async function seedBBSContent(): Promise<void> {
  const db = getDb();

  // Idempotency check: if AXIOM user exists, content has already been seeded
  const existingAxiom = await db.user.findUnique({ where: { handle: 'AXIOM' } });
  if (existingAxiom) {
    log.info('Seed content already exists, skipping');
    return;
  }

  // Load seed data config
  const configPath = resolve(getProjectRoot(), 'config/last-logon/seed-data.hjson');
  const raw = readFileSync(configPath, 'utf-8');
  const config = hjson.parse(raw) as SeedDataConfig;

  log.info('Seeding BBS content...');

  // ── 1. Create fake users ────────────────────────────────────────────────

  const userMap = new Map<string, number>(); // handle -> userId

  for (const u of config.users) {
    const user = await db.user.create({
      data: {
        handle: u.handle,
        passwordHash: '$argon2id$placeholder',
        accessLevel: 0,
        location: u.location,
        createdAt: new Date(u.createdAt),
        lastLoginAt: u.lastLoginAt ? new Date(u.lastLoginAt) : null,
        totalCalls: Math.floor(Math.random() * 200) + 10,
        totalPosts: 0, // will be updated after messages are created
      },
    });
    userMap.set(u.handle, user.id);
    log.info({ handle: u.handle, id: user.id }, 'Created seed user');
  }

  // ── 2. Create messages ──────────────────────────────────────────────────

  // Combine messages and messagesExtra
  const allMessages = [...config.messages, ...(config.messagesExtra ?? [])];

  // Cache area lookups
  const areaCache = new Map<string, number>(); // tag -> areaId

  // Track created messages for reply linking: subject -> messageId
  const messageSubjectMap = new Map<string, number>();

  // Track post counts per user
  const postCounts = new Map<string, number>();

  for (const msg of allMessages) {
    // Look up area
    let areaId = areaCache.get(msg.areaTag);
    if (areaId === undefined) {
      const area = await db.messageArea.findUnique({ where: { tag: msg.areaTag } });
      if (!area) {
        log.warn({ areaTag: msg.areaTag }, 'Message area not found, skipping message');
        continue;
      }
      areaId = area.id;
      areaCache.set(msg.areaTag, areaId);
    }

    const userId = userMap.get(msg.fromHandle);

    // Look up reply parent
    let replyToId: number | null = null;
    if (msg.replyToSubject) {
      const parentKey = `${msg.areaTag}:${msg.replyToSubject}`;
      replyToId = messageSubjectMap.get(parentKey) ?? null;
    }

    const createdAt = backdatedTimestamp(msg.daysAgo);

    const message = await db.message.create({
      data: {
        areaId,
        fromUserId: userId ?? null,
        fromName: msg.fromHandle,
        toName: msg.toName,
        subject: msg.subject,
        body: msg.body.trim(),
        replyToId,
        createdAt,
        origin: 'seed',
      },
    });

    // Track for reply linking — use the root subject for the area
    const subjectKey = `${msg.areaTag}:${msg.subject.replace(/^Re: /, '')}`;
    if (!messageSubjectMap.has(subjectKey)) {
      messageSubjectMap.set(subjectKey, message.id);
    }
    // Also track exact subject in case replies reference the full subject
    messageSubjectMap.set(`${msg.areaTag}:${msg.subject}`, message.id);

    // Count posts
    postCounts.set(msg.fromHandle, (postCounts.get(msg.fromHandle) ?? 0) + 1);
  }

  // Update user post counts
  for (const [handle, count] of postCounts) {
    const userId = userMap.get(handle);
    if (userId) {
      await db.user.update({
        where: { id: userId },
        data: { totalPosts: count },
      });
    }
  }

  log.info({ count: allMessages.length }, 'Seeded messages');

  // ── 3. Create one-liners ────────────────────────────────────────────────

  for (const liner of config.oneLiners) {
    const userId = userMap.get(liner.handle);
    if (!userId) {
      log.warn({ handle: liner.handle }, 'User not found for one-liner, skipping');
      continue;
    }

    await db.oneliner.create({
      data: {
        userId,
        handle: liner.handle,
        text: liner.text,
        postedAt: backdatedTimestamp(liner.daysAgo),
      },
    });
  }

  log.info({ count: config.oneLiners.length }, 'Seeded one-liners');

  // ── 4. Create last callers ──────────────────────────────────────────────

  for (const caller of config.lastCallers) {
    const userId = userMap.get(caller.handle);
    if (!userId) {
      log.warn({ handle: caller.handle }, 'User not found for last caller, skipping');
      continue;
    }

    await db.lastCaller.create({
      data: {
        userId,
        handle: caller.handle,
        location: caller.location || null,
        node: caller.node,
        loginAt: backdatedTimestamp(caller.daysAgo),
      },
    });
  }

  log.info({ count: config.lastCallers.length }, 'Seeded last callers');

  // ── 5. Create bulletins ─────────────────────────────────────────────────

  for (const bulletin of config.bulletins) {
    await db.bulletin.create({
      data: {
        number: bulletin.number,
        title: bulletin.title,
        body: bulletin.body.trim(),
        active: true,
      },
    });
  }

  log.info({ count: config.bulletins.length }, 'Seeded bulletins');

  log.info('BBS content seeding complete');
}
