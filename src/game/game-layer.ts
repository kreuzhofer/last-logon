// Game Layer — Central game logic and state management for Last Logon
// Sits between the BBS session and all modules, controlling what the player sees

import { getDb } from '../core/database.js';
import { eventBus } from '../core/events.js';
import { createChildLogger } from '../core/logger.js';
import {
  getBaseScript,
  getChapter,
  getChapterBeats,
  getNPCDef,
  getClueDef,
} from './base-script-loader.js';
import type {
  ChapterTag,
  GamePhase,
  KillerMood,
  StoryContext,
  StoryLogEntry,
  PlayerFlags,
  StoryBeat,
  BeatTrigger,
} from './game-types.js';
import type { PlayerGame, GameNPC } from '@prisma/client';

const log = createChildLogger('game-layer');

// ─── JSON field helpers ──────────────────────────────────────────────────────

function parseJsonArray(json: string): string[] {
  try { return JSON.parse(json) as string[]; } catch { return []; }
}

function parseJsonObject(json: string): Record<string, unknown> {
  try { return JSON.parse(json) as Record<string, unknown>; } catch { return {}; }
}

function parseStoryLog(json: string): StoryLogEntry[] {
  try { return JSON.parse(json) as StoryLogEntry[]; } catch { return []; }
}

// ─── Game State CRUD ─────────────────────────────────────────────────────────

export async function getPlayerGame(userId: number): Promise<PlayerGame | null> {
  const db = getDb();
  return db.playerGame.findUnique({ where: { userId } });
}

export async function createPlayerGame(userId: number, language: string, timezone = 'UTC'): Promise<PlayerGame> {
  const db = getDb();
  return db.playerGame.create({
    data: {
      userId,
      language,
      timezone,
      chapter: 'prologue',
      phase: 'prologue',
      killerAlias: 'AXIOM',
      killerProfile: '{}',
      unlockedFeatures: JSON.stringify(['messages', 'oneliners']),
      completedBeats: '[]',
      activeClues: '[]',
      solvedPuzzles: '[]',
      discoveredSecrets: '[]',
      storyLog: '[]',
      flags: '{}',
    },
  });
}

export async function updatePlayerGame(
  gameId: number,
  data: Partial<{
    chapter: string;
    phase: string;
    killerMood: string;
    killerTrust: number;
    suspicionLevel: number;
    totalSessions: number;
    totalInteractions: number;
    storySummary: string;
    unlockedFeatures: string;
    activeClues: string;
    solvedPuzzles: string;
    discoveredSecrets: string;
    completedBeats: string;
    storyLog: string;
    flags: string;
    lastActivity: Date;
    lastAiCall: Date;
  }>,
): Promise<PlayerGame> {
  const db = getDb();
  return db.playerGame.update({ where: { id: gameId }, data });
}

// ─── Story Context Builder ───────────────────────────────────────────────────

export async function buildStoryContext(game: PlayerGame): Promise<StoryContext> {
  const db = getDb();
  const npcs = await db.gameNPC.findMany({
    where: { playerGameId: game.id },
  });

  const recentEvents = parseStoryLog(game.storyLog).slice(-20);

  return {
    chapter: game.chapter as ChapterTag,
    phase: game.phase as GamePhase,
    killerMood: game.killerMood as KillerMood,
    killerAlias: game.killerAlias,
    language: game.language,
    cluesFound: parseJsonArray(game.activeClues),
    puzzlesSolved: parseJsonArray(game.solvedPuzzles),
    unlockedFeatures: parseJsonArray(game.unlockedFeatures),
    suspicionLevel: game.suspicionLevel,
    totalSessions: game.totalSessions,
    recentEvents,
    storySummary: game.storySummary,
    completedBeats: parseJsonArray(game.completedBeats),
    activeNPCs: npcs.map(n => ({
      handle: n.handle,
      role: n.role,
      relationship: n.relationship,
      status: n.status,
    })),
  };
}

// ─── Feature Unlocking ───────────────────────────────────────────────────────

export function getUnlockedFeatures(game: PlayerGame): string[] {
  return parseJsonArray(game.unlockedFeatures);
}

export function isFeatureUnlocked(game: PlayerGame, feature: string): boolean {
  const features = getUnlockedFeatures(game);
  return features.includes('*') || features.includes(feature);
}

export async function unlockFeatures(game: PlayerGame, features: string[]): Promise<void> {
  const current = parseJsonArray(game.unlockedFeatures);
  const updated = [...new Set([...current, ...features])];
  await updatePlayerGame(game.id, { unlockedFeatures: JSON.stringify(updated) });
  log.info({ gameId: game.id, features }, 'Features unlocked');
}

// ─── Clue Management ─────────────────────────────────────────────────────────

export async function addClue(game: PlayerGame, clueTag: string): Promise<void> {
  const current = parseJsonArray(game.activeClues);
  if (current.includes(clueTag)) return;

  const updated = [...current, clueTag];
  await updatePlayerGame(game.id, { activeClues: JSON.stringify(updated) });

  await addGameEvent(game, 'clue_found', `Clue discovered: ${clueTag}`, { clueTag }, 7);
  log.info({ gameId: game.id, clueTag }, 'Clue added');
}

export function hasClue(game: PlayerGame, clueTag: string): boolean {
  return parseJsonArray(game.activeClues).includes(clueTag);
}

// ─── Beat Management ─────────────────────────────────────────────────────────

export function getCompletedBeats(game: PlayerGame): string[] {
  return parseJsonArray(game.completedBeats);
}

export function isBeatCompleted(game: PlayerGame, beatTag: string): boolean {
  return getCompletedBeats(game).includes(beatTag);
}

export async function completeBeat(game: PlayerGame, beatTag: string): Promise<void> {
  const current = getCompletedBeats(game);
  if (current.includes(beatTag)) return;

  const updated = [...current, beatTag];
  await updatePlayerGame(game.id, { completedBeats: JSON.stringify(updated) });

  await addGameEvent(game, 'beat_completed', `Beat completed: ${beatTag}`, { beatTag }, 8);
  log.info({ gameId: game.id, beatTag }, 'Beat completed');
}

// ─── Puzzle Management ───────────────────────────────────────────────────────

export async function markPuzzleSolved(game: PlayerGame, puzzleTag: string): Promise<void> {
  const current = parseJsonArray(game.solvedPuzzles);
  if (current.includes(puzzleTag)) return;

  const updated = [...current, puzzleTag];
  await updatePlayerGame(game.id, { solvedPuzzles: JSON.stringify(updated) });

  await addGameEvent(game, 'puzzle_solved', `Puzzle solved: ${puzzleTag}`, { puzzleTag }, 8);
  log.info({ gameId: game.id, puzzleTag }, 'Puzzle marked as solved');
}

export function isPuzzleSolved(game: PlayerGame, puzzleTag: string): boolean {
  return parseJsonArray(game.solvedPuzzles).includes(puzzleTag);
}

// ─── Story Log ───────────────────────────────────────────────────────────────

export async function addStoryLogEntry(
  game: PlayerGame,
  type: StoryLogEntry['type'],
  summary: string,
  details?: Record<string, unknown>,
): Promise<void> {
  const entries = parseStoryLog(game.storyLog);
  entries.push({
    timestamp: new Date().toISOString(),
    type,
    summary,
    details,
  });
  // Keep last 100 entries
  const trimmed = entries.slice(-100);
  await updatePlayerGame(game.id, { storyLog: JSON.stringify(trimmed) });
}

// ─── Game Events (for AI memory) ─────────────────────────────────────────────

export async function addGameEvent(
  game: PlayerGame,
  eventType: string,
  summary: string,
  details: Record<string, unknown> = {},
  importance: number = 5,
): Promise<void> {
  const db = getDb();
  await db.gameEvent.create({
    data: {
      playerGameId: game.id,
      eventType,
      chapter: game.chapter,
      summary,
      details: JSON.stringify(details),
      importance,
    },
  });
}

// ─── NPC Management ──────────────────────────────────────────────────────────

export async function getGameNPCs(game: PlayerGame): Promise<GameNPC[]> {
  const db = getDb();
  return db.gameNPC.findMany({ where: { playerGameId: game.id } });
}

export async function createGameNPC(
  game: PlayerGame,
  tag: string,
): Promise<GameNPC> {
  const npcDef = getNPCDef(tag);
  if (!npcDef) throw new Error(`NPC definition not found: ${tag}`);

  const db = getDb();
  const personality = game.language === 'de' && npcDef.personalityDe
    ? npcDef.personalityDe
    : npcDef.personality;

  return db.gameNPC.create({
    data: {
      playerGameId: game.id,
      handle: npcDef.handle,
      role: npcDef.role,
      personality,
      status: 'active',
      relationship: 'stranger',
    },
  });
}

export async function getOrCreateNPC(game: PlayerGame, tag: string): Promise<GameNPC> {
  const npcDef = getNPCDef(tag);
  if (!npcDef) throw new Error(`NPC definition not found: ${tag}`);

  const db = getDb();
  const existing = await db.gameNPC.findUnique({
    where: { playerGameId_handle: { playerGameId: game.id, handle: npcDef.handle } },
  });
  if (existing) return existing;
  return createGameNPC(game, tag);
}

// ─── Chapter Progression ─────────────────────────────────────────────────────

export async function checkChapterProgression(game: PlayerGame): Promise<boolean> {
  const chapter = getChapter(game.chapter as ChapterTag);
  if (!chapter?.progression) return false;

  const completedBeats = getCompletedBeats(game);
  const requiredBeats = chapter.progression.requires;
  const allRequired = requiredBeats.every(b => completedBeats.includes(b));

  if (!allRequired) return false;

  // Check minimum logins if specified
  if (chapter.progression.minLogins && game.totalSessions < chapter.progression.minLogins) return false;

  // Determine which chapter to advance to (supports branching endings)
  let nextChapter = chapter.progression.advanceTo;

  if (chapter.progression.alternateAdvanceTo && chapter.progression.alternateCondition) {
    const shouldTakeAlternate = evaluateAlternateCondition(
      chapter.progression.alternateCondition,
      game,
    );
    if (shouldTakeAlternate) {
      nextChapter = chapter.progression.alternateAdvanceTo;
    }
  }

  const phase = getPhaseForChapter(nextChapter as ChapterTag);

  await updatePlayerGame(game.id, {
    chapter: nextChapter,
    phase,
  });

  await addGameEvent(game, 'chapter_change', `Advanced to ${nextChapter}`, { from: game.chapter, to: nextChapter }, 10);
  log.info({ gameId: game.id, from: game.chapter, to: nextChapter }, 'Chapter advanced');

  return true;
}

/**
 * Evaluate whether a chapter should branch to its alternate path.
 * Currently supports:
 * - "timeout_or_wrong": killer escapes if suspicion is low (player wasn't thorough enough)
 *   The "caught" ending requires suspicion >= 60 (player gathered enough evidence against killer).
 *   Otherwise the killer escapes.
 */
function evaluateAlternateCondition(condition: string, game: PlayerGame): boolean {
  switch (condition) {
    case 'timeout_or_wrong':
      // Player needs high suspicion (evidence of wrongdoing) to catch the killer.
      // Below threshold = killer escapes (alternate path).
      return game.suspicionLevel < 60;
    default:
      log.warn({ condition }, 'Unknown alternate condition, using primary path');
      return false;
  }
}

function getPhaseForChapter(chapter: ChapterTag): GamePhase {
  switch (chapter) {
    case 'prologue': return 'prologue';
    case 'chapter1': return 'suspicious';
    case 'chapter2': return 'aware';
    case 'chapter3': return 'hunted';
    case 'chapter4':
    case 'chapter5_caught':
    case 'chapter5_escaped':
      return 'endgame';
    default: return 'prologue';
  }
}

// ─── Beat Trigger Checking ───────────────────────────────────────────────────

export function checkBeatTrigger(
  beat: StoryBeat,
  game: PlayerGame,
  action?: { type: string; value?: string },
): boolean {
  if (isBeatCompleted(game, beat.tag)) return false;

  const trigger = beat.trigger;
  if (trigger === 'auto') return true;

  const t = trigger as BeatTrigger;
  switch (t.type) {
    case 'auto':
      return true;
    case 'login_count':
      return game.totalSessions >= (t.min ?? 1);
    case 'interaction_count':
      return game.totalInteractions >= (t.min ?? 1);
    case 'area_visit':
      return action?.type === 'area_visit' && action.value === t.area;
    case 'player_action':
      return action?.type === 'player_action' && action.value === t.action;
    case 'clue_found':
      return hasClue(game, t.clue ?? '');
    case 'puzzle_solved':
      return isPuzzleSolved(game, t.puzzle ?? '');
    default:
      return false;
  }
}

export function getTriggeredBeats(
  game: PlayerGame,
  action?: { type: string; value?: string },
): StoryBeat[] {
  const beats = getChapterBeats(game.chapter as ChapterTag);
  return beats.filter(beat => checkBeatTrigger(beat, game, action));
}

// ─── Session Lifecycle ───────────────────────────────────────────────────────

export async function onPlayerLogin(userId: number): Promise<PlayerGame | null> {
  const game = await getPlayerGame(userId);
  if (!game) return null;

  await updatePlayerGame(game.id, {
    totalSessions: game.totalSessions + 1,
    lastActivity: new Date(),
  });

  await addGameEvent(game, 'login', `Player logged in (session ${game.totalSessions + 1})`, {}, 3);

  // Reload with updated data
  return getPlayerGame(userId);
}

export async function onPlayerLogout(userId: number): Promise<void> {
  const game = await getPlayerGame(userId);
  if (!game) return;

  await updatePlayerGame(game.id, { lastActivity: new Date() });
  await addGameEvent(game, 'logout', 'Player logged out', {}, 2);
}

// ─── Mood & Trust Updates ────────────────────────────────────────────────────

export async function updateKillerMood(game: PlayerGame, mood: KillerMood): Promise<void> {
  await updatePlayerGame(game.id, { killerMood: mood });
}

export async function adjustTrust(game: PlayerGame, delta: number): Promise<void> {
  const newTrust = Math.max(-100, Math.min(100, game.killerTrust + delta));
  await updatePlayerGame(game.id, { killerTrust: newTrust });
}

export async function adjustSuspicion(game: PlayerGame, delta: number): Promise<void> {
  const newSuspicion = Math.max(0, Math.min(100, game.suspicionLevel + delta));
  await updatePlayerGame(game.id, { suspicionLevel: newSuspicion });
}

// ─── Apply Killer Response Effects ───────────────────────────────────────────

export async function applyKillerResponseEffects(
  game: PlayerGame,
  response: { mood?: KillerMood; trustDelta?: number; suspicionDelta?: number; clueRevealed?: string; unlocks?: string[]; beatTriggered?: string },
): Promise<void> {
  if (response.mood) {
    await updateKillerMood(game, response.mood);
  }
  if (response.trustDelta) {
    await adjustTrust(game, response.trustDelta);
  }
  if (response.suspicionDelta) {
    await adjustSuspicion(game, response.suspicionDelta);
  }
  if (response.clueRevealed) {
    await addClue(game, response.clueRevealed);
  }
  if (response.unlocks?.length) {
    await unlockFeatures(game, response.unlocks);
  }
  if (response.beatTriggered) {
    await completeBeat(game, response.beatTriggered);
  }

  // Increment interactions
  await updatePlayerGame(game.id, {
    totalInteractions: game.totalInteractions + 1,
    lastAiCall: new Date(),
  });
}

// ─── Notifications ───────────────────────────────────────────────────────────

export async function getPendingNotifications(userId: number): Promise<Array<{ id: number; type: string; content: string }>> {
  const db = getDb();
  return db.gameNotification.findMany({
    where: { userId, read: false },
    orderBy: { createdAt: 'asc' },
    select: { id: true, type: true, content: true },
  });
}

export async function markNotificationsRead(userId: number): Promise<void> {
  const db = getDb();
  await db.gameNotification.updateMany({
    where: { userId, read: false },
    data: { read: true },
  });
}

export async function createNotification(userId: number, type: string, content: string): Promise<void> {
  const db = getDb();
  await db.gameNotification.create({
    data: { userId, type, content },
  });
}

// ─── Adaptive Difficulty (tracked in playerProfile JSON) ────────────────────

export interface PlayerSkillProfile {
  puzzlesSolvedCount: number;
  puzzlesFailedCount: number;
  averageSolveTimeMs: number;    // Average time to solve puzzles
  hintsUsedTotal: number;
  attemptsPerPuzzle: number;     // Average attempts per puzzle
  responseSpeed: 'fast' | 'medium' | 'slow';
  estimatedSkill: 'beginner' | 'intermediate' | 'advanced' | 'expert';
  lastUpdated: string;           // ISO datetime
}

export function getPlayerSkillProfile(game: PlayerGame): PlayerSkillProfile {
  const profile = parseJsonObject(game.playerProfile);
  const skill = profile.skill as PlayerSkillProfile | undefined;
  if (skill) return skill;
  return {
    puzzlesSolvedCount: 0,
    puzzlesFailedCount: 0,
    averageSolveTimeMs: 0,
    hintsUsedTotal: 0,
    attemptsPerPuzzle: 0,
    responseSpeed: 'medium',
    estimatedSkill: 'intermediate',
    lastUpdated: new Date().toISOString(),
  };
}

export async function updatePlayerSkillProfile(game: PlayerGame, update: Partial<PlayerSkillProfile>): Promise<void> {
  const profile = parseJsonObject(game.playerProfile);
  const current = getPlayerSkillProfile(game);
  const updated = { ...current, ...update, lastUpdated: new Date().toISOString() };

  // Auto-estimate skill level based on metrics
  if (updated.puzzlesSolvedCount >= 3) {
    const solveRate = updated.puzzlesSolvedCount / (updated.puzzlesSolvedCount + updated.puzzlesFailedCount);
    const hintsRate = updated.hintsUsedTotal / Math.max(1, updated.puzzlesSolvedCount);

    if (solveRate > 0.9 && hintsRate < 0.5 && updated.attemptsPerPuzzle < 3) {
      updated.estimatedSkill = 'expert';
    } else if (solveRate > 0.7 && hintsRate < 1.5) {
      updated.estimatedSkill = 'advanced';
    } else if (solveRate > 0.4) {
      updated.estimatedSkill = 'intermediate';
    } else {
      updated.estimatedSkill = 'beginner';
    }
  }

  profile.skill = updated;
  await updatePlayerGame(game.id, { playerProfile: JSON.stringify(profile) });
}

export function getDifficultyMultiplier(game: PlayerGame): number {
  const skill = getPlayerSkillProfile(game);
  switch (skill.estimatedSkill) {
    case 'beginner': return 0.5;    // Easier puzzles, more hints
    case 'intermediate': return 1.0; // Standard difficulty
    case 'advanced': return 1.5;     // Harder, fewer hints
    case 'expert': return 2.0;       // Maximum challenge
    default: return 1.0;
  }
}

// ─── Story Threads (tracked in PlayerGame.flags) ────────────────────────────

export interface StoryThread {
  areaTag: string;
  subject: string;
  npcHandles: string[];
  hintsDropped: string[];
  playerPostCount: number;
  lastNPCResponseAt: string;
  lastPlayerPostAt: string;
  createdAt: string;
}

export interface StoryThreads {
  threads: StoryThread[];
  lastNPCResponseAt: string | null;
}

export function getStoryThreads(game: PlayerGame): StoryThreads {
  const flags = parseJsonObject(game.flags);
  const raw = flags.storyThreads as StoryThreads | undefined;
  if (raw && Array.isArray(raw.threads)) return raw;
  return { threads: [], lastNPCResponseAt: null };
}

export async function updateStoryThreads(game: PlayerGame, threads: StoryThreads): Promise<void> {
  const flags = parseJsonObject(game.flags);
  flags.storyThreads = threads;
  await updatePlayerGame(game.id, { flags: JSON.stringify(flags) });
}
