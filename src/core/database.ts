// Prisma client singleton

import { PrismaClient } from '@prisma/client';
import { createChildLogger } from './logger.js';

const log = createChildLogger('database');

let prisma: PrismaClient | undefined;

export function getDb(): PrismaClient {
  if (!prisma) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return prisma;
}

export async function initDatabase(): Promise<PrismaClient> {
  prisma = new PrismaClient();
  await prisma.$connect();
  log.info('Database connected via Prisma');
  return prisma;
}

export async function closeDatabase(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = undefined;
    log.info('Database disconnected');
  }
}
