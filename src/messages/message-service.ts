import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import hjson from 'hjson';
import type { MessageArea, MessageConference, Message } from '@prisma/client';
import { getDb } from '../core/database.js';
import { getProjectRoot } from '../core/config.js';
import { createChildLogger } from '../core/logger.js';
import { eventBus } from '../core/events.js';

const log = createChildLogger('messages');

export type { MessageArea, MessageConference, Message };

// ─── Area/Conference Seeding (global — structural, not per-user) ────────────

export async function seedMessageAreas(): Promise<void> {
  const configPath = resolve(getProjectRoot(), 'config/message-areas.hjson');
  if (!existsSync(configPath)) return;

  const raw = readFileSync(configPath, 'utf-8');
  const config = hjson.parse(raw) as {
    conferences: Array<{
      tag: string;
      name: string;
      description?: string;
      areas: Array<{
        tag: string;
        name: string;
        description?: string;
        minReadLevel?: number;
        minWriteLevel?: number;
      }>;
    }>;
  };

  const db = getDb();

  let confOrder = 0;
  for (const conf of config.conferences) {
    const conference = await db.messageConference.upsert({
      where: { tag: conf.tag },
      create: {
        tag: conf.tag,
        name: conf.name,
        description: conf.description ?? null,
        sortOrder: confOrder++,
      },
      update: {},
    });

    let areaOrder = 0;
    for (const area of conf.areas) {
      await db.messageArea.upsert({
        where: { tag: area.tag },
        create: {
          conferenceId: conference.id,
          tag: area.tag,
          name: area.name,
          description: area.description ?? null,
          sortOrder: areaOrder++,
          minReadLevel: area.minReadLevel ?? 20,
          minWriteLevel: area.minWriteLevel ?? 20,
        },
        update: {},
      });
    }
  }

  log.info('Message areas seeded from config');
}

// ─── Area/Conference Queries (global) ───────────────────────────────────────

export async function getConferences(): Promise<MessageConference[]> {
  return getDb().messageConference.findMany({ orderBy: { sortOrder: 'asc' } });
}

export async function getAreasForConference(conferenceId: number): Promise<MessageArea[]> {
  return getDb().messageArea.findMany({
    where: { conferenceId },
    orderBy: { sortOrder: 'asc' },
  });
}

export async function getAllAreas(): Promise<MessageArea[]> {
  return getDb().messageArea.findMany({ orderBy: { tag: 'asc' } });
}

export async function getAreaByTag(tag: string): Promise<MessageArea | null> {
  return getDb().messageArea.findUnique({ where: { tag } });
}

// ─── Message Queries (per-player scoped) ────────────────────────────────────

export async function getMessages(playerGameId: number, areaId: number, limit = 50, offset = 0): Promise<Message[]> {
  return getDb().message.findMany({
    where: { playerGameId, areaId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  });
}

export async function getMessage(messageId: number): Promise<Message | null> {
  return getDb().message.findUnique({ where: { id: messageId } });
}

export async function getMessageCount(playerGameId: number, areaId: number): Promise<number> {
  return getDb().message.count({ where: { playerGameId, areaId } });
}

export async function getUnreadCount(playerGameId: number, areaId: number, userId: number): Promise<number> {
  const db = getDb();

  const readRecord = await db.messageRead.findUnique({
    where: { userId_areaId: { userId, areaId } },
  });

  const lastReadId = readRecord?.lastReadId ?? 0;

  return db.message.count({
    where: { playerGameId, areaId, id: { gt: lastReadId } },
  });
}

export async function postMessage(
  playerGameId: number,
  areaId: number,
  fromUserId: number | null,
  fromName: string,
  subject: string,
  body: string,
  options?: { toName?: string; replyToId?: number },
): Promise<Message> {
  const db = getDb();

  const message = await db.message.create({
    data: {
      playerGameId,
      areaId,
      fromUserId,
      fromName,
      toName: options?.toName ?? 'All',
      subject,
      body,
      replyToId: options?.replyToId ?? null,
    },
  });

  // Update user's post count (skip for system/NPC messages with no user)
  if (fromUserId) {
    await db.user.update({
      where: { id: fromUserId },
      data: { totalPosts: { increment: 1 } },
    });
  }

  const area = await db.messageArea.findUnique({ where: { id: areaId }, select: { tag: true } });

  log.info({ messageId: message.id, area: area?.tag, from: fromName, subject }, 'New message posted');
  eventBus.emit('message:new', { areaTag: area?.tag ?? '', messageId: message.id, from: fromName, subject });

  return message;
}

export async function markRead(userId: number, areaId: number, messageId: number): Promise<void> {
  const db = getDb();

  // Only advance the read pointer, never go backwards
  const existing = await db.messageRead.findUnique({
    where: { userId_areaId: { userId, areaId } },
  });

  if (!existing) {
    await db.messageRead.create({ data: { userId, areaId, lastReadId: messageId } });
  } else if (messageId > existing.lastReadId) {
    await db.messageRead.update({
      where: { userId_areaId: { userId, areaId } },
      data: { lastReadId: messageId },
    });
  }
}

// ─── Personal Mail (per-player scoped) ──────────────────────────────────────

const MAIL_AREA_TAG = 'mail.personal';

export async function getMailForUser(playerGameId: number, userHandle: string, limit = 50): Promise<Message[]> {
  const db = getDb();
  const area = await db.messageArea.findUnique({ where: { tag: MAIL_AREA_TAG } });
  if (!area) return [];

  return db.message.findMany({
    where: { playerGameId, areaId: area.id, toName: userHandle },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export async function getUnreadMailCount(playerGameId: number, userId: number, userHandle: string): Promise<number> {
  const db = getDb();
  const area = await db.messageArea.findUnique({ where: { tag: MAIL_AREA_TAG } });
  if (!area) return 0;

  const readRecord = await db.messageRead.findUnique({
    where: { userId_areaId: { userId, areaId: area.id } },
  });
  const lastReadId = readRecord?.lastReadId ?? 0;

  return db.message.count({
    where: { playerGameId, areaId: area.id, toName: userHandle, id: { gt: lastReadId } },
  });
}

export async function sendMail(
  playerGameId: number,
  fromUserId: number | null,
  fromName: string,
  toName: string,
  subject: string,
  body: string,
): Promise<Message> {
  const db = getDb();
  const area = await db.messageArea.findUnique({ where: { tag: MAIL_AREA_TAG } });
  if (!area) throw new Error('Mail area not found');

  return postMessage(playerGameId, area.id, fromUserId, fromName, subject, body, { toName });
}

export async function getMailAreaId(): Promise<number | null> {
  const area = await getDb().messageArea.findUnique({ where: { tag: MAIL_AREA_TAG } });
  return area?.id ?? null;
}
