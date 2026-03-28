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
  } catch {
    return false;
  }
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
      realName: options?.realName ?? null,
      email: options?.email ?? null,
      location: options?.location ?? '',
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

  // Record last caller
  await db.lastCaller.create({
    data: {
      userId: user.id,
      handle: user.handle,
      location: user.location,
      node: nodeNumber,
    },
  });

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
