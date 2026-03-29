// Tests for message-service.ts — database-backed message system operations

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  seedMessageAreas,
  getConferences,
  getAreasForConference,
  getAllAreas,
  getAreaByTag,
  getMessages,
  getMessage,
  getMessageCount,
  getUnreadCount,
  postMessage,
  markRead,
} from '../../src/messages/message-service.js';
import { initDatabase, closeDatabase, getDb } from '../../src/core/database.js';

let db: PrismaClient;
let testUserId: number;

beforeAll(async () => {
  db = await initDatabase();

  // Clean any stale data from previous runs
  await db.messageRead.deleteMany();
  await db.message.deleteMany();
  await db.messageArea.deleteMany();
  await db.messageConference.deleteMany();
  await db.user.deleteMany();

  // Create a test user for posting messages
  const user = await db.user.create({
    data: {
      handle: 'TestUser',
      passwordHash: 'test-hash-not-real',
      accessLevel: 100,
      totalPosts: 0,
    },
  });
  testUserId = user.id;
});

afterAll(async () => {
  // Clean up test data
  if (db) {
    await db.messageRead.deleteMany();
    await db.message.deleteMany();
    await db.messageArea.deleteMany();
    await db.messageConference.deleteMany();
    await db.user.deleteMany();
    await closeDatabase();
  }
});

// ─── seedMessageAreas ────────────────────────────────────────────────────────

describe('seedMessageAreas', () => {
  beforeEach(async () => {
    // Clean message-related tables before each seed test
    await db.messageRead.deleteMany();
    await db.message.deleteMany();
    await db.messageArea.deleteMany();
    await db.messageConference.deleteMany();
  });

  it('should seed conferences and areas from config', async () => {
    await seedMessageAreas();

    const conferences = await db.messageConference.findMany();
    const areas = await db.messageArea.findMany();

    // config/message-areas.hjson defines 3 conferences: local, retro, tech
    expect(conferences.length).toBe(3);
    expect(conferences.map(c => c.tag).sort()).toEqual(['local', 'retro', 'tech']);

    // local: 2 areas, retro: 3 areas, tech: 2 areas = 7 total
    expect(areas.length).toBe(7);
    expect(areas.map(a => a.tag).sort()).toEqual([
      'local.general',
      'local.sysop',
      'retro.bbs',
      'retro.hardware',
      'retro.software',
      'tech.ai',
      'tech.programming',
    ]);
  });

  it('should be idempotent — running twice does not duplicate records', async () => {
    await seedMessageAreas();
    await seedMessageAreas();

    const conferences = await db.messageConference.findMany();
    const areas = await db.messageArea.findMany();

    expect(conferences.length).toBe(3);
    expect(areas.length).toBe(7);
  });
});

// ─── getConferences ──────────────────────────────────────────────────────────

describe('getConferences', () => {
  beforeAll(async () => {
    // Ensure areas are seeded
    await db.messageRead.deleteMany();
    await db.message.deleteMany();
    await db.messageArea.deleteMany();
    await db.messageConference.deleteMany();
    await seedMessageAreas();
  });

  it('should return conferences ordered by sortOrder', async () => {
    const conferences = await getConferences();

    expect(conferences.length).toBe(3);
    // The config lists them as: local (0), retro (1), tech (2)
    expect(conferences[0].tag).toBe('local');
    expect(conferences[1].tag).toBe('retro');
    expect(conferences[2].tag).toBe('tech');

    // Verify sortOrder is ascending
    for (let i = 1; i < conferences.length; i++) {
      expect(conferences[i].sortOrder).toBeGreaterThanOrEqual(conferences[i - 1].sortOrder);
    }
  });
});

// ─── getAreasForConference ───────────────────────────────────────────────────

describe('getAreasForConference', () => {
  it('should return areas for a specific conference', async () => {
    const conferences = await getConferences();
    const retroConf = conferences.find(c => c.tag === 'retro')!;
    expect(retroConf).toBeDefined();

    const areas = await getAreasForConference(retroConf.id);

    expect(areas.length).toBe(3);
    expect(areas.map(a => a.tag).sort()).toEqual([
      'retro.bbs',
      'retro.hardware',
      'retro.software',
    ]);

    // Verify sortOrder is ascending
    for (let i = 1; i < areas.length; i++) {
      expect(areas[i].sortOrder).toBeGreaterThanOrEqual(areas[i - 1].sortOrder);
    }
  });

  it('should return empty array for non-existent conference', async () => {
    const areas = await getAreasForConference(99999);
    expect(areas).toEqual([]);
  });
});

// ─── getAllAreas / getAreaByTag ───────────────────────────────────────────────

describe('getAllAreas', () => {
  it('should return all areas', async () => {
    const areas = await getAllAreas();
    expect(areas.length).toBe(7);
  });

  it('should return areas ordered by tag ascending', async () => {
    const areas = await getAllAreas();
    const tags = areas.map(a => a.tag);
    const sorted = [...tags].sort();
    expect(tags).toEqual(sorted);
  });
});

describe('getAreaByTag', () => {
  it('should return an area by tag', async () => {
    const area = await getAreaByTag('local.general');
    expect(area).not.toBeNull();
    expect(area!.tag).toBe('local.general');
    expect(area!.name).toBe('General Discussion');
  });

  it('should return null for non-existent tag', async () => {
    const area = await getAreaByTag('nonexistent.area');
    expect(area).toBeNull();
  });
});

// ─── postMessage ─────────────────────────────────────────────────────────────

describe('postMessage', () => {
  let areaId: number;

  beforeAll(async () => {
    const area = await getAreaByTag('local.general');
    areaId = area!.id;

    // Reset user totalPosts
    await db.user.update({
      where: { id: testUserId },
      data: { totalPosts: 0 },
    });
  });

  beforeEach(async () => {
    // Clean messages between tests
    await db.message.deleteMany();
  });

  it('should create a message and return it', async () => {
    const msg = await postMessage(areaId, testUserId, 'TestUser', 'Hello World', 'This is a test message');

    expect(msg).toBeDefined();
    expect(msg.id).toBeGreaterThan(0);
    expect(msg.areaId).toBe(areaId);
    expect(msg.fromUserId).toBe(testUserId);
    expect(msg.fromName).toBe('TestUser');
    expect(msg.subject).toBe('Hello World');
    expect(msg.body).toBe('This is a test message');
    expect(msg.toName).toBe('All');
    expect(msg.replyToId).toBeNull();
  });

  it('should increment user totalPosts', async () => {
    // Reset posts
    await db.user.update({
      where: { id: testUserId },
      data: { totalPosts: 0 },
    });

    await postMessage(areaId, testUserId, 'TestUser', 'Post 1', 'Body 1');
    await postMessage(areaId, testUserId, 'TestUser', 'Post 2', 'Body 2');

    const user = await db.user.findUnique({ where: { id: testUserId } });
    expect(user!.totalPosts).toBe(2);
  });

  it('should set toName when provided', async () => {
    const msg = await postMessage(areaId, testUserId, 'TestUser', 'DM', 'Private', { toName: 'OtherUser' });

    expect(msg.toName).toBe('OtherUser');
  });

  it('should set replyToId when provided', async () => {
    const original = await postMessage(areaId, testUserId, 'TestUser', 'Original', 'Original body');
    const reply = await postMessage(areaId, testUserId, 'TestUser', 'Re: Original', 'Reply body', {
      replyToId: original.id,
    });

    expect(reply.replyToId).toBe(original.id);
  });
});

// ─── getMessages ─────────────────────────────────────────────────────────────

describe('getMessages', () => {
  let areaId: number;

  beforeAll(async () => {
    await db.message.deleteMany();

    const area = await getAreaByTag('local.general');
    areaId = area!.id;

    // Create messages with slight time separation to ensure ordering
    for (let i = 1; i <= 5; i++) {
      await postMessage(areaId, testUserId, 'TestUser', `Message ${i}`, `Body ${i}`);
    }
  });

  it('should return messages for an area in descending order by createdAt', async () => {
    const messages = await getMessages(areaId);

    expect(messages.length).toBe(5);
    // descending order means most recent first
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i - 1].createdAt.getTime()).toBeGreaterThanOrEqual(messages[i].createdAt.getTime());
    }
  });

  it('should respect limit parameter', async () => {
    const messages = await getMessages(areaId, 3);
    expect(messages.length).toBe(3);
  });

  it('should respect offset parameter', async () => {
    const allMessages = await getMessages(areaId);
    const offsetMessages = await getMessages(areaId, 50, 2);

    expect(offsetMessages.length).toBe(3);
    // offset=2 should skip the first 2 messages (most recent)
    expect(offsetMessages[0].id).toBe(allMessages[2].id);
  });

  it('should return empty array for area with no messages', async () => {
    const techArea = await getAreaByTag('tech.programming');
    const messages = await getMessages(techArea!.id);
    expect(messages).toEqual([]);
  });
});

// ─── getMessage ──────────────────────────────────────────────────────────────

describe('getMessage', () => {
  let existingMessageId: number;

  beforeAll(async () => {
    const area = await getAreaByTag('local.general');
    const msg = await postMessage(area!.id, testUserId, 'TestUser', 'Findable', 'Can be found by ID');
    existingMessageId = msg.id;
  });

  it('should return a message by ID', async () => {
    const msg = await getMessage(existingMessageId);
    expect(msg).not.toBeNull();
    expect(msg!.id).toBe(existingMessageId);
    expect(msg!.subject).toBe('Findable');
  });

  it('should return null for non-existent message ID', async () => {
    const msg = await getMessage(999999);
    expect(msg).toBeNull();
  });
});

// ─── getMessageCount ─────────────────────────────────────────────────────────

describe('getMessageCount', () => {
  let areaId: number;

  beforeAll(async () => {
    await db.message.deleteMany();

    const area = await getAreaByTag('retro.hardware');
    areaId = area!.id;

    await postMessage(areaId, testUserId, 'TestUser', 'HW 1', 'Hardware post 1');
    await postMessage(areaId, testUserId, 'TestUser', 'HW 2', 'Hardware post 2');
    await postMessage(areaId, testUserId, 'TestUser', 'HW 3', 'Hardware post 3');
  });

  it('should return correct message count for an area', async () => {
    const count = await getMessageCount(areaId);
    expect(count).toBe(3);
  });

  it('should return 0 for area with no messages', async () => {
    const emptyArea = await getAreaByTag('tech.ai');
    const count = await getMessageCount(emptyArea!.id);
    expect(count).toBe(0);
  });
});

// ─── getUnreadCount + markRead ───────────────────────────────────────────────

describe('getUnreadCount and markRead', () => {
  let areaId: number;
  let messageIds: number[];

  beforeAll(async () => {
    await db.messageRead.deleteMany();
    await db.message.deleteMany();

    const area = await getAreaByTag('local.general');
    areaId = area!.id;

    messageIds = [];
    for (let i = 1; i <= 4; i++) {
      const msg = await postMessage(areaId, testUserId, 'TestUser', `Msg ${i}`, `Body ${i}`);
      messageIds.push(msg.id);
    }
  });

  it('should return total message count when nothing is read', async () => {
    const unread = await getUnreadCount(areaId, testUserId);
    expect(unread).toBe(4);
  });

  it('should decrease unread count after marking a message as read', async () => {
    // Mark the second message as read (all messages up to that ID are considered read)
    await markRead(testUserId, areaId, messageIds[1]);

    const unread = await getUnreadCount(areaId, testUserId);
    // Messages with id > messageIds[1] are unread — that should be messageIds[2] and messageIds[3]
    expect(unread).toBe(2);
  });

  it('should return 0 unread when all messages are marked read', async () => {
    // Mark the last message as read
    await markRead(testUserId, areaId, messageIds[3]);

    const unread = await getUnreadCount(areaId, testUserId);
    expect(unread).toBe(0);
  });

  it('should handle markRead idempotently (upsert)', async () => {
    // Mark read again with the same message ID — should not throw
    await markRead(testUserId, areaId, messageIds[3]);

    const unread = await getUnreadCount(areaId, testUserId);
    expect(unread).toBe(0);
  });

  it('should track read status independently per user', async () => {
    // Create a second user
    const user2 = await db.user.create({
      data: {
        handle: 'TestUser2',
        passwordHash: 'test-hash-not-real',
        accessLevel: 100,
        totalPosts: 0,
      },
    });

    // User2 has not read anything
    const unreadUser2 = await getUnreadCount(areaId, user2.id);
    expect(unreadUser2).toBe(4);

    // Clean up user2
    await db.user.delete({ where: { id: user2.id } });
  });
});
