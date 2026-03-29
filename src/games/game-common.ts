// Shared types and utilities for mini-games
// Each game returns a result indicating if secrets/clues were found

import type { Session } from '../auth/session.js';
import type { ScreenFrame } from '../terminal/screen-frame.js';
import type { PlayerGame } from '@prisma/client';
import type { ChapterTag } from '../game/game-types.js';
import { getDb } from '../core/database.js';

export interface GameResult {
  secretFound?: string;
  clueRevealed?: string;
}

export type MiniGame = (
  session: Session,
  frame: ScreenFrame,
  game: PlayerGame,
) => Promise<GameResult>;

// ─── Chapter helpers ────────────────────────────────────────────────────────

export function getChapterNumber(chapter: string): number {
  switch (chapter as ChapterTag) {
    case 'prologue': return 0;
    case 'chapter1': return 1;
    case 'chapter2': return 2;
    case 'chapter3': return 3;
    case 'chapter4': return 4;
    case 'chapter5_caught':
    case 'chapter5_escaped':
      return 5;
    default: return 0;
  }
}

// ─── Game state persistence ─────────────────────────────────────────────────

export async function loadGameState<T>(gameTag: string, userId: number): Promise<T | null> {
  const db = getDb();
  const record = await db.gameState.findUnique({
    where: { gameTag_userId: { gameTag, userId } },
  });
  if (!record) return null;
  try {
    return JSON.parse(record.state) as T;
  } catch {
    return null;
  }
}

export async function saveGameState<T>(gameTag: string, userId: number, state: T): Promise<void> {
  const db = getDb();
  await db.gameState.upsert({
    where: { gameTag_userId: { gameTag, userId } },
    update: { state: JSON.stringify(state) },
    create: { gameTag, userId, state: JSON.stringify(state) },
  });
}

export async function saveHighScore(
  gameTag: string,
  userId: number,
  handle: string,
  score: number,
  metadata?: string,
): Promise<void> {
  const db = getDb();
  await db.gameScore.create({
    data: { gameTag, userId, handle, score, metadata },
  });
}

// ─── Simple sleep helper ────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Non-blocking key check ─────────────────────────────────────────────────
// Reads a key with a timeout. Returns null if no key pressed within the timeout.

export function readKeyWithTimeout(
  session: Session,
  timeoutMs: number,
): Promise<import('../terminal/input-handler.js').KeyInput | null> {
  return new Promise(resolve => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    }, timeoutMs);

    session.terminal.readKey().then(key => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(key);
      }
    }).catch(() => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  });
}
