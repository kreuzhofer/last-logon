import argon2 from 'argon2';
import type { User } from '@prisma/client';
import { getDb } from '../core/database.js';
import { createChildLogger } from '../core/logger.js';
import { AuthError } from '../core/errors.js';
import { eventBus } from '../core/events.js';

const log = createChildLogger('auth');

export type { User };

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch (err) {
    log.warn({ error: err }, 'Password verification error (corrupt hash or argon2 failure)');
    return false;
  }
}

const HANDLE_REGEX = /^[a-zA-Z0-9_\-]{2,30}$/;
const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/g;

function validateHandle(handle: string): void {
  if (!handle || !HANDLE_REGEX.test(handle)) {
    throw new AuthError('Handle must be 2-30 characters: letters, numbers, underscore, or hyphen.');
  }
}

function sanitizeTextField(value: string, maxLength: number): string {
  return value.replace(CONTROL_CHAR_REGEX, '').substring(0, maxLength);
}

export async function registerUser(
  handle: string,
  password: string,
  options?: {
    realName?: string;
    email?: string;
    location?: string;
    accessLevel?: number;
  },
): Promise<User> {
  const db = getDb();

  validateHandle(handle);

  const existing = await db.user.findUnique({ where: { handle } });
  if (existing) {
    throw new AuthError(`Handle "${handle}" is already taken`);
  }

  if (options?.email) {
    const existingEmail = await db.user.findUnique({ where: { email: options.email } });
    if (existingEmail) {
      throw new AuthError('Email address is already registered');
    }
  }

  const passwordHash = await hashPassword(password);

  const user = await db.user.create({
    data: {
      handle,
      passwordHash,
      realName: options?.realName ? sanitizeTextField(options.realName, 50) : null,
      email: options?.email ?? null,
      location: options?.location ? sanitizeTextField(options.location, 50) : '',
      accessLevel: options?.accessLevel ?? 20,
      firstLoginAt: new Date(),
      lastLoginAt: new Date(),
    },
  });

  log.info({ userId: user.id, handle }, 'New user registered');
  return user;
}

export async function loginUser(
  handle: string,
  password: string,
  remoteAddress: string,
  nodeNumber: number,
): Promise<User> {
  const db = getDb();

  validateHandle(handle);

  const user = await db.user.findUnique({ where: { handle } });

  if (!user) {
    throw new AuthError('Invalid handle or password');
  }

  if (user.accessLevel === 0) {
    throw new AuthError('Account is locked. Contact the SysOp.');
  }

  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid) {
    throw new AuthError('Invalid handle or password');
  }

  // Update login stats
  await db.user.update({
    where: { id: user.id },
    data: {
      totalCalls: { increment: 1 },
      lastLoginAt: new Date(),
      lastLoginFrom: remoteAddress,
    },
  });

  // Note: lastCaller record is created in bbs.ts where playerGameId is available

  // Upsert node
  await db.node.upsert({
    where: { nodeNumber },
    create: {
      nodeNumber,
      userId: user.id,
      remoteAddress,
      connectedAt: new Date(),
      activity: 'Main Menu',
      authenticated: true,
    },
    update: {
      userId: user.id,
      remoteAddress,
      connectedAt: new Date(),
      activity: 'Main Menu',
      authenticated: true,
    },
  });

  log.info({ userId: user.id, handle, node: nodeNumber }, 'User logged in');
  eventBus.emit('user:login', { nodeNumber, userId: user.id, handle: user.handle });

  // Return refreshed user
  return (await db.user.findUnique({ where: { id: user.id } }))!;
}

export async function logoutUser(userId: number, nodeNumber: number): Promise<void> {
  const db = getDb();

  await db.node.deleteMany({ where: { nodeNumber } });

  const user = await db.user.findUnique({ where: { id: userId }, select: { handle: true } });
  if (user) {
    log.info({ userId, handle: user.handle, node: nodeNumber }, 'User logged out');
    eventBus.emit('user:logoff', { nodeNumber, userId });
  }
}

export async function getUserByHandle(handle: string): Promise<User | null> {
  return getDb().user.findUnique({ where: { handle } });
}

export async function getUserById(id: number): Promise<User | null> {
  return getDb().user.findUnique({ where: { id } });
}
