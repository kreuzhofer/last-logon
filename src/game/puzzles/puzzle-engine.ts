// Puzzle Engine — framework for defining, presenting, and validating puzzles
// Supports multiple validation strategies: exact, fuzzy, rot13, numeric, AI

import { getDb } from '../../core/database.js';
import { createChildLogger } from '../../core/logger.js';
import { getPuzzleDef } from '../base-script-loader.js';
import { evaluateFreeFormAnswer, generatePuzzleHint } from '../ai-engine.js';
import { displayText } from '../narrative.js';
import type { Terminal } from '../../terminal/terminal.js';
import type { ScreenFrame, HotkeyDef } from '../../terminal/screen-frame.js';
import type { Session } from '../../auth/session.js';
import type { PuzzleDef, PuzzleInstance, StoryContext } from '../game-types.js';
import type { PlayerGame } from '@prisma/client';
import { Color, setColor, resetColor } from '../../terminal/ansi.js';
import { parsePipeCodes } from '../../utils/pipe-codes.js';
import { getConfig } from '../../core/config.js';
import {
  markPuzzleSolved,
  addClue,
  unlockFeatures,
  updateKillerMood,
  adjustTrust,
  completeBeat,
  addStoryLogEntry,
} from '../game-layer.js';

const log = createChildLogger('puzzle-engine');

// ─── Puzzle State Management ─────────────────────────────────────────────────

export async function getPuzzleState(userId: number, puzzleTag: string): Promise<{
  solved: boolean;
  attempts: number;
  hintsUsed: number;
  instanceData: Record<string, unknown>;
} | null> {
  const db = getDb();
  const state = await db.gamePuzzleState.findUnique({
    where: { userId_puzzleTag: { userId, puzzleTag } },
  });
  if (!state) return null;
  return {
    solved: state.solved,
    attempts: state.attempts,
    hintsUsed: state.hintsUsed,
    instanceData: JSON.parse(state.instanceData) as Record<string, unknown>,
  };
}

export async function getOrCreatePuzzleState(userId: number, puzzleTag: string): Promise<{
  id: number;
  solved: boolean;
  attempts: number;
  hintsUsed: number;
  instanceData: Record<string, unknown>;
}> {
  const db = getDb();
  const existing = await db.gamePuzzleState.findUnique({
    where: { userId_puzzleTag: { userId, puzzleTag } },
  });
  if (existing) {
    return {
      id: existing.id,
      solved: existing.solved,
      attempts: existing.attempts,
      hintsUsed: existing.hintsUsed,
      instanceData: JSON.parse(existing.instanceData) as Record<string, unknown>,
    };
  }
  const created = await db.gamePuzzleState.create({
    data: { userId, puzzleTag, instanceData: '{}' },
  });
  return {
    id: created.id,
    solved: false,
    attempts: 0,
    hintsUsed: 0,
    instanceData: {},
  };
}

// ─── Validation Strategies ───────────────────────────────────────────────────

function rot13(text: string): string {
  return text.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

function normalizeAnswer(answer: string): string {
  return answer.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ');
}

export function validateAnswer(
  puzzleDef: PuzzleDef,
  playerAnswer: string,
): { correct: boolean; partial: boolean } {
  const normalized = normalizeAnswer(playerAnswer);

  switch (puzzleDef.validator) {
    case 'exact': {
      const answers = (puzzleDef.answers ?? []).map(normalizeAnswer);
      return { correct: answers.includes(normalized), partial: false };
    }

    case 'fuzzy': {
      const answers = (puzzleDef.answers ?? []).map(normalizeAnswer);
      const exactMatch = answers.includes(normalized);
      if (exactMatch) return { correct: true, partial: false };

      // Check fuzzy tokens
      const tokens = (puzzleDef.fuzzyTokens ?? []).map(t => t.toLowerCase());
      const hasAllTokens = tokens.every(t => normalized.includes(t));
      return { correct: hasAllTokens, partial: tokens.some(t => normalized.includes(t)) };
    }

    case 'rot13': {
      // Player should provide the decoded text
      const answers = (puzzleDef.answers ?? []).map(normalizeAnswer);
      const exactMatch = answers.includes(normalized);
      if (exactMatch) return { correct: true, partial: false };

      const tokens = (puzzleDef.fuzzyTokens ?? []).map(t => t.toLowerCase());
      const hasAllTokens = tokens.every(t => normalized.includes(t));
      return { correct: hasAllTokens, partial: tokens.some(t => normalized.includes(t)) };
    }

    case 'numeric': {
      const answers = (puzzleDef.answers ?? []).map(a => parseFloat(a));
      const playerNum = parseFloat(playerAnswer.trim());
      return { correct: answers.includes(playerNum), partial: false };
    }

    case 'contains': {
      const tokens = (puzzleDef.fuzzyTokens ?? []).map(t => t.toLowerCase());
      const hasAll = tokens.every(t => normalized.includes(t));
      return { correct: hasAll, partial: tokens.some(t => normalized.includes(t)) };
    }

    case 'ai':
      // AI validation is handled separately via evaluateFreeFormAnswer
      return { correct: false, partial: false };

    default:
      return { correct: false, partial: false };
  }
}

// ─── Puzzle UI ───────────────────────────────────────────────────────────────

const HOTKEYS_PUZZLE: HotkeyDef[] = [
  { key: 'H', label: 'Hint' },
  { key: 'Q', label: 'Back' },
];

export async function runPuzzle(
  session: Session,
  frame: ScreenFrame,
  puzzleTag: string,
  game: PlayerGame,
  context: StoryContext,
): Promise<boolean> {
  const terminal = session.terminal;
  const config = getConfig();
  const puzzleDef = getPuzzleDef(puzzleTag);
  if (!puzzleDef) {
    log.error({ puzzleTag }, 'Puzzle definition not found');
    return false;
  }

  const userId = session.user!.id;
  const state = await getOrCreatePuzzleState(userId, puzzleTag);

  if (state.solved) {
    frame.refresh([config.general.bbsName, 'Puzzle', puzzleDef.tag], HOTKEYS_PUZZLE);
    frame.skipLine();
    const solvedMsg = context.language === 'de'
      ? '|10Dieses Rätsel hast du bereits gelöst.|08'
      : '|10You have already solved this puzzle.|08';
    frame.writeContentLine(parsePipeCodes(solvedMsg));
    frame.skipLine();
    terminal.moveTo(frame.currentRow, frame.contentLeft);
    await terminal.pause();
    return true;
  }

  while (true) {
    frame.refresh([config.general.bbsName, 'Puzzle', puzzleDef.tag], HOTKEYS_PUZZLE);
    frame.skipLine();

    // Display puzzle text
    const presentation = (context.language === 'de' && puzzleDef.presentationDe)
      ? puzzleDef.presentationDe
      : puzzleDef.presentation;
    displayText(frame, presentation.trim());
    frame.skipLine();

    // Show attempt info
    const db = getDb();
    const currentState = await db.gamePuzzleState.findUnique({
      where: { userId_puzzleTag: { userId, puzzleTag } },
    });
    const attempts = currentState?.attempts ?? 0;
    const hintsUsed = currentState?.hintsUsed ?? 0;

    const attemptsLeft = puzzleDef.maxAttempts - attempts;
    if (attemptsLeft <= 0) {
      const maxMsg = context.language === 'de'
        ? '|12Maximale Versuche erreicht. Komm später wieder.|08'
        : '|12Maximum attempts reached. Come back later.|08';
      frame.writeContentLine(parsePipeCodes(maxMsg));
      frame.skipLine();
      terminal.moveTo(frame.currentRow, frame.contentLeft);
      await terminal.pause();
      return false;
    }

    const infoMsg = context.language === 'de'
      ? `|08Versuche übrig: ${attemptsLeft} | Hinweise: ${hintsUsed}/${puzzleDef.hints.length}`
      : `|08Attempts left: ${attemptsLeft} | Hints: ${hintsUsed}/${puzzleDef.hints.length}`;
    frame.writeContentLine(parsePipeCodes(infoMsg));
    frame.skipLine();

    // Prompt
    terminal.moveTo(frame.currentRow, frame.contentLeft);
    terminal.write(setColor(Color.LightCyan) + '> ' + setColor(Color.White));
    const answer = await terminal.readLine({ maxLength: 200 });

    if (!answer) {
      return false; // Player pressed enter without typing
    }

    const upperAnswer = answer.toUpperCase().trim();
    if (upperAnswer === 'Q') return false;

    if (upperAnswer === 'H') {
      // Show hint
      await showHint(frame, terminal, puzzleDef, hintsUsed, userId, context);
      // Increment hints used
      await db.gamePuzzleState.update({
        where: { userId_puzzleTag: { userId, puzzleTag } },
        data: { hintsUsed: hintsUsed + 1 },
      });
      terminal.moveTo(frame.currentRow, frame.contentLeft);
      await terminal.pause();
      continue;
    }

    // Validate answer
    await db.gamePuzzleState.update({
      where: { userId_puzzleTag: { userId, puzzleTag } },
      data: { attempts: attempts + 1 },
    });

    let correct = false;

    if (puzzleDef.validator === 'ai') {
      // Use AI to evaluate
      frame.writeContentLine(setColor(Color.DarkGray) + 'Evaluating...' + resetColor());
      const result = await evaluateFreeFormAnswer(userId, puzzleTag, puzzleDef.type, answer, context);
      correct = result.correct;
      frame.skipLine();
      frame.writeContentLine(parsePipeCodes(result.feedback));
    } else {
      const result = validateAnswer(puzzleDef, answer);
      correct = result.correct;

      if (!correct && result.partial) {
        const partialMsg = context.language === 'de'
          ? '|14Du bist auf dem richtigen Weg...|08'
          : '|14You\'re on the right track...|08';
        frame.skipLine();
        frame.writeContentLine(parsePipeCodes(partialMsg));
      }
    }

    if (correct) {
      // Puzzle solved!
      await db.gamePuzzleState.update({
        where: { userId_puzzleTag: { userId, puzzleTag } },
        data: { solved: true, solvedAt: new Date() },
      });

      await markPuzzleSolved(game, puzzleTag);

      // Apply rewards
      if (puzzleDef.onSolve.clue) {
        await addClue(game, puzzleDef.onSolve.clue);
      }
      if (puzzleDef.onSolve.unlocks?.length) {
        await unlockFeatures(game, puzzleDef.onSolve.unlocks);
      }
      if (puzzleDef.onSolve.killerResponse) {
        await updateKillerMood(game, puzzleDef.onSolve.killerResponse);
      }
      if (puzzleDef.onSolve.trustDelta) {
        await adjustTrust(game, puzzleDef.onSolve.trustDelta);
      }

      await addStoryLogEntry(game, 'puzzle', `Solved puzzle: ${puzzleTag}`);

      frame.skipLine();
      const solvedMsg = context.language === 'de'
        ? '|10═══ RÄTSEL GELÖST ═══|08'
        : '|10═══ PUZZLE SOLVED ═══|08';
      frame.writeContentLine(parsePipeCodes(solvedMsg));
      frame.skipLine();
      terminal.moveTo(frame.currentRow, frame.contentLeft);
      await terminal.pause();

      log.info({ userId, puzzleTag }, 'Puzzle solved');
      return true;
    }

    // Wrong answer
    frame.skipLine();
    const wrongMsg = context.language === 'de'
      ? '|12Das ist nicht korrekt.|08'
      : '|12That is not correct.|08';
    frame.writeContentLine(parsePipeCodes(wrongMsg));
    frame.skipLine();
    terminal.moveTo(frame.currentRow, frame.contentLeft);
    await terminal.pause();
  }
}

async function showHint(
  frame: ScreenFrame,
  terminal: Terminal,
  puzzleDef: PuzzleDef,
  hintsUsed: number,
  userId: number,
  context: StoryContext,
): Promise<void> {
  const hints = (context.language === 'de' && puzzleDef.hintsDe?.length)
    ? puzzleDef.hintsDe
    : puzzleDef.hints;

  if (hintsUsed < hints.length) {
    // Use pre-defined hint
    frame.skipLine();
    const label = context.language === 'de' ? '|14Hinweis' : '|14Hint';
    frame.writeContentLine(parsePipeCodes(`${label}: ${hints[hintsUsed]!}`));
  } else {
    // Use AI to generate additional hint
    frame.skipLine();
    frame.writeContentLine(setColor(Color.DarkGray) + 'Generating hint...' + resetColor());
    const hint = await generatePuzzleHint(
      userId,
      puzzleDef.tag,
      puzzleDef.presentation,
      hintsUsed,
      hintsUsed,
      context,
    );
    frame.writeContentLine(parsePipeCodes(hint));
  }
}
