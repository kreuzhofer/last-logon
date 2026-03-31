// Puzzle Recognizer — checks arbitrary player text against pending puzzles
// Used by all 4 discovery channels: chat, terminal, games, message boards
// The player never sees a "puzzle" — they just discover and discuss things

import { createChildLogger } from '../../core/logger.js';
import { getDb } from '../../core/database.js';
import { getPuzzleDefs, getPuzzleDef } from '../base-script-loader.js';
import {
  markPuzzleSolved,
  isPuzzleSolved,
  addClue,
  unlockFeatures,
  adjustTrust,
  updatePlayerGame,
  addStoryLogEntry,
  addGameEvent,
  completeBeat,
  getCompletedBeats,
  checkChapterProgression,
} from '../game-layer.js';
import { getChapterBeats } from '../base-script-loader.js';
import { validateAnswer } from './puzzle-engine.js';
import type { PlayerGame } from '@prisma/client';
import type { PuzzleDef, ChapterTag } from '../game-types.js';

const log = createChildLogger('puzzle-recognizer');

// Chapter ordering for filtering
const CHAPTER_ORDER: ChapterTag[] = [
  'prologue', 'chapter1', 'chapter2', 'chapter3', 'chapter4',
  'chapter5_caught', 'chapter5_escaped',
];

export interface RecognitionResult {
  puzzleTag: string;
  puzzleDef: PuzzleDef;
  channel: string;
  confidence: 'exact' | 'fuzzy' | 'partial';
}

/**
 * Check if player text matches any pending (unsolved) puzzle's answer.
 * Skips AI-validated puzzles (those are handled by the chat AI).
 * Only checks puzzles from the current chapter or earlier.
 */
export function checkTextAgainstPendingPuzzles(
  game: PlayerGame,
  text: string,
  channel: string,
): RecognitionResult | null {
  if (!text || text.trim().length < 2) return null;

  const allPuzzles = getPuzzleDefs();
  const currentChapterIdx = CHAPTER_ORDER.indexOf(game.chapter as ChapterTag);

  for (const puzzleDef of allPuzzles) {
    // Skip already solved
    if (isPuzzleSolved(game, puzzleDef.tag)) continue;

    // Skip AI-validated puzzles (handled by chat AI)
    if (puzzleDef.validator === 'ai') continue;

    // Skip puzzles from future chapters
    const puzzleChapterIdx = CHAPTER_ORDER.indexOf(puzzleDef.chapter);
    if (puzzleChapterIdx > currentChapterIdx) continue;

    // Validate the text against this puzzle's answers
    const result = validateAnswer(puzzleDef, text.trim());

    if (result.correct) {
      log.info({ puzzleTag: puzzleDef.tag, channel, confidence: 'exact' }, 'Puzzle answer recognized');
      return {
        puzzleTag: puzzleDef.tag,
        puzzleDef,
        channel,
        confidence: 'exact',
      };
    }

    if (result.partial) {
      // For partial matches, require at least 2 token matches to avoid false positives
      const tokens = puzzleDef.fuzzyTokens ?? [];
      const normalized = text.trim().toLowerCase();
      const matchCount = tokens.filter(t => normalized.includes(t.toLowerCase())).length;
      if (matchCount >= 2) {
        log.info({ puzzleTag: puzzleDef.tag, channel, confidence: 'fuzzy', matchCount }, 'Puzzle partial match recognized');
        return {
          puzzleTag: puzzleDef.tag,
          puzzleDef,
          channel,
          confidence: 'fuzzy',
        };
      }
    }
  }

  return null;
}

/**
 * Apply all effects when a puzzle is solved through any channel.
 * Extracted from the old runPuzzle reward logic for reuse across channels.
 */
export async function applyPuzzleSolvedEffects(
  game: PlayerGame,
  puzzleTag: string,
  channel: string,
): Promise<boolean> {
  // Guard: already solved
  if (isPuzzleSolved(game, puzzleTag)) return false;

  const puzzleDef = getPuzzleDef(puzzleTag);
  if (!puzzleDef) {
    log.warn({ puzzleTag }, 'Puzzle definition not found');
    return false;
  }

  // Mark solved
  await markPuzzleSolved(game, puzzleTag);

  // Apply onSolve effects
  if (puzzleDef.onSolve) {
    if (puzzleDef.onSolve.clue) {
      await addClue(game, puzzleDef.onSolve.clue);
    }
    if (puzzleDef.onSolve.unlocks?.length) {
      await unlockFeatures(game, puzzleDef.onSolve.unlocks);
    }
    if (puzzleDef.onSolve.trustDelta) {
      await adjustTrust(game, puzzleDef.onSolve.trustDelta);
    }
    if (puzzleDef.onSolve.killerResponse) {
      await updatePlayerGame(game.id, { killerMood: puzzleDef.onSolve.killerResponse });
    }
  }

  // Log the solve
  await addStoryLogEntry(game, 'puzzle', `Solved ${puzzleTag} via ${channel}`);
  await addGameEvent(game, 'puzzle_solved', `Puzzle ${puzzleTag} solved via ${channel}`, { puzzleTag, channel }, 8);

  // Find and complete the associated beat
  const chapterBeats = getChapterBeats(game.chapter as ChapterTag);
  const associatedBeat = chapterBeats.find(b => b.puzzle === puzzleTag);
  if (associatedBeat && !getCompletedBeats(game).includes(associatedBeat.tag)) {
    await completeBeat(game, associatedBeat.tag);
  }

  // Check if this advances the chapter
  await checkChapterProgression(game);

  log.info({ gameId: game.id, puzzleTag, channel }, 'Puzzle solved and effects applied');
  return true;
}
