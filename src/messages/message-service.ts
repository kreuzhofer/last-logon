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

export async function getMessages(areaId: number, limit = 50, offset = 0): Promise<Message[]> {
  return getDb().message.findMany({
    where: { areaId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  });
}

export async function getMessage(messageId: number): Promise<Message | null> {
  return getDb().message.findUnique({ where: { id: messageId } });
}

export async function getMessageCount(areaId: number): Promise<number> {
  return getDb().message.count({ where: { areaId } });
}

export async function getUnreadCount(areaId: number, userId: number): Promise<number> {
  const db = getDb();

  const readRecord = await db.messageRead.findUnique({
    where: { userId_areaId: { userId, areaId } },
  });

  const lastReadId = readRecord?.lastReadId ?? 0;

  return db.message.count({
    where: { areaId, id: { gt: lastReadId } },
  });
}

export async function postMessage(
  areaId: number,
  fromUserId: number,
  fromName: string,
  subject: string,
  body: string,
  options?: { toName?: string; replyToId?: number },
): Promise<Message> {
  const db = getDb();

  const message = await db.message.create({
    data: {
      areaId,
      fromUserId,
      fromName,
      toName: options?.toName ?? 'All',
      subject,
      body,
      replyToId: options?.replyToId ?? null,
    },
  });

  // Update user's post count
  await db.user.update({
    where: { id: fromUserId },
    data: { totalPosts: { increment: 1 } },
  });

  const area = await db.messageArea.findUnique({ where: { id: areaId }, select: { tag: true } });

  log.info({ messageId: message.id, area: area?.tag, from: fromName, subject }, 'New message posted');
  eventBus.emit('message:new', { areaTag: area?.tag ?? '', messageId: message.id, from: fromName, subject });

  return message;
}

export async function markRead(userId: number, areaId: number, messageId: number): Promise<void> {
  const db = getDb();

  await db.messageRead.upsert({
    where: { userId_areaId: { userId, areaId } },
    create: { userId, areaId, lastReadId: messageId },
    update: { lastReadId: messageId },
  });
}
