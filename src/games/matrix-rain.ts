// Matrix Rain — A "screen saver" style Matrix rain animation
// Green cascading characters fall; occasionally a real word appears.
// Player types the word they spot to capture it. After 3 captures, a secret is revealed.

import { Color, setColor, resetColor } from '../terminal/ansi.js';
import type { Session } from '../auth/session.js';
import type { ScreenFrame } from '../terminal/screen-frame.js';
import type { PlayerGame } from '@prisma/client';
import type { GameResult } from './game-common.js';
import {
  getChapterNumber,
  loadGameState,
  saveGameState,
  saveHighScore,
  sleep,
  readKeyWithTimeout,
} from './game-common.js';

// ─── Story-relevant word pools per chapter ──────────────────────────────────

const WORD_POOLS: Record<number, string[]> = {
  0: ['AXIOM', 'SYSTEM', 'SIGNAL', 'GHOST', 'ECHO', 'NODE', 'SHADOW', 'TRACE'],
  1: ['FRIDAY', 'CIPHER', 'NIGHTOWL', 'VANISHED', 'HIDDEN', 'RIDDLE', 'ROTATE', 'THIRTEEN'],
  2: ['BASEMENT', 'TERMINAL', 'DCOLE', 'INVESTIGATE', 'MISSING', 'ACCESS', 'LOCKED', 'BREACH'],
  3: ['DECRYPT', 'LOGFILE', 'SERVER', 'TRACED', 'EVIDENCE', 'KILLER', 'NETWORK', 'ORIGIN'],
  4: ['CONFRONT', 'CAUGHT', 'ESCAPED', 'TRUTH', 'IDENTITY', 'MOTIVE', 'JUSTICE', 'FINALE'],
  5: ['ENDGAME', 'LEGACY', 'AXIOM', 'REMEMBER', 'FOREVER', 'RETURN', 'SILENCE', 'LOGON'],
};

const SECRET_MESSAGES: Record<number, string> = {
  0: 'A ghost user once typed: "He watches from the admin panel. Always."',
  1: 'Decoded transmission: "The ROT13 cipher was just the beginning."',
  2: 'Former user SIGNAL_LOST left a note: "Check the basement logs. The timestamps lie."',
  3: 'Intercepted data fragment: "Server origin masked by 3 proxy hops. Trace 10.13.37.x"',
  4: 'Final broadcast from ECHO_7: "All evidence points to one admin. One alias. One AXIOM."',
  5: 'System log recovered: "Last logon recorded. No further entries. Connection terminated."',
};

interface MatrixState {
  capturedWords: string[];
  secretRevealed: boolean;
  totalCaptures: number;
  highestStreak: number;
}

// ─── Rain column state ──────────────────────────────────────────────────────

interface RainColumn {
  row: number;       // Current head position
  speed: number;     // Rows per tick
  length: number;    // Trail length
  chars: string[];   // Characters in the trail
  active: boolean;
  tickAccum: number; // Accumulated ticks for fractional speed
}

const RAIN_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%&*+=<>?/|\\~';

function randomRainChar(): string {
  return RAIN_CHARS[Math.floor(Math.random() * RAIN_CHARS.length)]!;
}

// ─── Main game ──────────────────────────────────────────────────────────────

export async function matrixRain(
  session: Session,
  frame: ScreenFrame,
  game: PlayerGame,
): Promise<GameResult> {
  const terminal = session.terminal;
  const chapter = getChapterNumber(game.chapter);
  const userId = game.userId;

  // Load persistent state
  let state = await loadGameState<MatrixState>('matrix_rain', userId);
  if (!state) {
    state = { capturedWords: [], secretRevealed: false, totalCaptures: 0, highestStreak: 0 };
  }

  // Pick words for this session based on chapter
  const pool = WORD_POOLS[Math.min(chapter, 5)] ?? WORD_POOLS[0]!;
  // Filter out already-captured words
  const availableWords = pool.filter(w => !state!.capturedWords.includes(w));

  // Setup screen
  frame.refresh(['Games', 'Matrix Rain'], [
    { key: 'ESC', label: 'Exit' },
  ]);
  frame.clearContent();

  const TOP = frame.contentTop;
  const LEFT = frame.contentLeft;
  const WIDTH = frame.contentWidth;
  const HEIGHT = frame.contentHeight;
  const BOTTOM = TOP + HEIGHT - 1;

  // Status bar area (bottom 3 rows of content area)
  const RAIN_HEIGHT = HEIGHT - 3;
  const STATUS_ROW = TOP + RAIN_HEIGHT;

  // Initialize rain columns
  const columns: RainColumn[] = [];
  for (let col = 0; col < WIDTH; col++) {
    columns.push(createColumn(RAIN_HEIGHT));
  }

  // Hidden word state
  let hiddenWord: string | null = null;
  let hiddenWordCol = 0;
  let hiddenWordRow = 0;
  let hiddenWordVisible = false;
  let hiddenWordTimer = 0;
  let nextWordTick = randomBetween(150, 300); // ticks until next word appears
  let typedBuffer = '';
  let capturesThisSession = 0;
  let streak = 0;
  let totalTicks = 0;
  let resultClue: string | undefined;
  let resultSecret: string | undefined;

  // Draw initial status
  drawStatus(terminal, STATUS_ROW, LEFT, WIDTH, typedBuffer, capturesThisSession, state.totalCaptures, streak);

  terminal.hideCursor();

  // Game loop — tick every ~50ms
  let running = true;
  while (running) {
    totalTicks++;

    // Update rain columns
    for (let col = 0; col < WIDTH; col++) {
      const column = columns[col]!;
      if (!column.active) {
        // Random chance to reactivate
        if (Math.random() < 0.02) {
          columns[col] = createColumn(RAIN_HEIGHT);
        }
        continue;
      }

      column.tickAccum += column.speed;
      if (column.tickAccum < 1) continue;
      column.tickAccum -= 1;

      // Advance the column
      column.row++;
      if (column.row - column.length > RAIN_HEIGHT) {
        column.active = false;
        // Clear the tail
        for (let r = Math.max(0, column.row - column.length); r < RAIN_HEIGHT; r++) {
          terminal.moveTo(TOP + r, LEFT + col);
          terminal.write(' ');
        }
        continue;
      }

      // Draw head character (bright white/green)
      if (column.row >= 0 && column.row < RAIN_HEIGHT) {
        terminal.moveTo(TOP + column.row, LEFT + col);
        terminal.write(setColor(Color.White) + randomRainChar());
      }

      // Fade previous head to green
      if (column.row - 1 >= 0 && column.row - 1 < RAIN_HEIGHT) {
        terminal.moveTo(TOP + column.row - 1, LEFT + col);
        terminal.write(setColor(Color.LightGreen) + randomRainChar());
      }

      // Fade deeper trail to dark green
      if (column.row - 2 >= 0 && column.row - 2 < RAIN_HEIGHT) {
        terminal.moveTo(TOP + column.row - 2, LEFT + col);
        terminal.write(setColor(Color.DarkGreen) + randomRainChar());
      }

      // Erase tail
      const tailPos = column.row - column.length;
      if (tailPos >= 0 && tailPos < RAIN_HEIGHT) {
        terminal.moveTo(TOP + tailPos, LEFT + col);
        terminal.write(' ');
      }
    }

    // Hidden word logic
    if (!hiddenWordVisible && availableWords.length > 0) {
      nextWordTick--;
      if (nextWordTick <= 0) {
        // Show a hidden word
        hiddenWord = availableWords[Math.floor(Math.random() * availableWords.length)]!;
        hiddenWordCol = Math.floor(Math.random() * Math.max(1, WIDTH - hiddenWord.length));
        hiddenWordRow = Math.floor(Math.random() * Math.max(1, RAIN_HEIGHT - 2)) + 1;
        hiddenWordVisible = true;
        hiddenWordTimer = 60; // visible for ~3 seconds (60 ticks at 50ms)
      }
    }

    if (hiddenWordVisible && hiddenWord) {
      hiddenWordTimer--;
      // Draw the hidden word in yellow so it stands out
      if (hiddenWordTimer > 0) {
        terminal.moveTo(TOP + hiddenWordRow, LEFT + hiddenWordCol);
        terminal.write(setColor(Color.Yellow) + hiddenWord + resetColor());
      } else {
        // Erase it
        terminal.moveTo(TOP + hiddenWordRow, LEFT + hiddenWordCol);
        terminal.write(' '.repeat(hiddenWord.length));
        hiddenWordVisible = false;
        nextWordTick = randomBetween(150, 300);
        hiddenWord = null;
      }
    }

    // Check for input (non-blocking)
    const key = await readKeyWithTimeout(session, 50);

    if (key) {
      if (key.type === 'special' && key.value === 'ESCAPE') {
        running = false;
        break;
      }

      if (key.type === 'special' && key.value === 'ENTER') {
        // Check if typed buffer matches the hidden word
        const typed = typedBuffer.trim().toUpperCase();
        if (typed.length > 0 && hiddenWord && typed === hiddenWord.toUpperCase()) {
          // Captured!
          capturesThisSession++;
          streak++;
          state.totalCaptures++;
          if (!state.capturedWords.includes(hiddenWord)) {
            state.capturedWords.push(hiddenWord);
          }

          // Flash success
          terminal.moveTo(STATUS_ROW + 1, LEFT);
          terminal.write(
            setColor(Color.LightGreen) +
            `  CAPTURED: ${hiddenWord}!` +
            ' '.repeat(Math.max(0, WIDTH - hiddenWord.length - 14)) +
            resetColor(),
          );

          // Remove from available
          const idx = availableWords.indexOf(hiddenWord);
          if (idx >= 0) availableWords.splice(idx, 1);

          // Clear the word from screen
          terminal.moveTo(TOP + hiddenWordRow, LEFT + hiddenWordCol);
          terminal.write(' '.repeat(hiddenWord.length));
          hiddenWordVisible = false;
          hiddenWord = null;
          nextWordTick = randomBetween(100, 200);

          // Check if 3 captured this session -> reveal secret
          if (capturesThisSession >= 3 && !state.secretRevealed) {
            state.secretRevealed = true;
            resultSecret = SECRET_MESSAGES[Math.min(chapter, 5)];
            resultClue = chapter >= 2 ? 'matrix_rain_secret' : undefined;
          }

          if (streak > state.highestStreak) {
            state.highestStreak = streak;
          }
        } else if (typed.length > 0) {
          // Wrong word
          streak = 0;
          terminal.moveTo(STATUS_ROW + 1, LEFT);
          terminal.write(
            setColor(Color.LightRed) +
            `  Wrong: "${typed}"` +
            ' '.repeat(Math.max(0, WIDTH - typed.length - 12)) +
            resetColor(),
          );
        }
        typedBuffer = '';
        drawStatus(terminal, STATUS_ROW, LEFT, WIDTH, typedBuffer, capturesThisSession, state.totalCaptures, streak);
      } else if (key.type === 'special' && key.value === 'BACKSPACE') {
        typedBuffer = typedBuffer.slice(0, -1);
        drawStatus(terminal, STATUS_ROW, LEFT, WIDTH, typedBuffer, capturesThisSession, state.totalCaptures, streak);
      } else if (key.type === 'char') {
        if (typedBuffer.length < 20) {
          typedBuffer += key.value;
          drawStatus(terminal, STATUS_ROW, LEFT, WIDTH, typedBuffer, capturesThisSession, state.totalCaptures, streak);
        }
      }
    }
  }

  terminal.showCursor();

  // Show secret message if earned
  if (resultSecret) {
    frame.clearContent();
    frame.setBreadcrumb('Games', 'Matrix Rain', 'Secret Found');
    frame.skipLine();
    frame.writeContentLine(setColor(Color.Yellow) + '  === SECRET TRANSMISSION INTERCEPTED ===' + resetColor());
    frame.skipLine();
    // Word-wrap the secret message
    const words = resultSecret.split(' ');
    let line = '  ';
    for (const word of words) {
      if (line.length + word.length + 1 > WIDTH - 2) {
        frame.writeContentLine(setColor(Color.LightGreen) + line + resetColor());
        line = '  ' + word;
      } else {
        line += (line.length > 2 ? ' ' : '') + word;
      }
    }
    if (line.length > 2) {
      frame.writeContentLine(setColor(Color.LightGreen) + line + resetColor());
    }
    frame.skipLine();
    frame.writeContentLine(setColor(Color.DarkGray) + '  Press any key to continue...' + resetColor());
    await session.terminal.readKey();
  }

  // Save state and score
  await saveGameState('matrix_rain', userId, state);
  if (capturesThisSession > 0) {
    await saveHighScore('matrix_rain', userId, session.handle, capturesThisSession, JSON.stringify({ streak: state.highestStreak }));
  }

  return { secretFound: resultSecret, clueRevealed: resultClue };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function createColumn(maxHeight: number): RainColumn {
  return {
    row: -Math.floor(Math.random() * maxHeight),
    speed: 0.3 + Math.random() * 0.7,
    length: 3 + Math.floor(Math.random() * (maxHeight / 2)),
    chars: [],
    active: true,
    tickAccum: 0,
  };
}

function randomBetween(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function drawStatus(
  terminal: import('../terminal/terminal.js').Terminal,
  statusRow: number,
  left: number,
  width: number,
  typed: string,
  captures: number,
  totalCaptures: number,
  streak: number,
): void {
  // Divider line
  terminal.moveTo(statusRow, left);
  terminal.write(setColor(Color.DarkGreen) + '-'.repeat(width) + resetColor());

  // Input line
  terminal.moveTo(statusRow + 2, left);
  terminal.write(
    setColor(Color.DarkCyan) + '  Type: ' +
    setColor(Color.White) + typed +
    ' '.repeat(Math.max(0, 20 - typed.length)) +
    setColor(Color.DarkGray) + '  Captures: ' +
    setColor(Color.LightCyan) + String(captures) +
    setColor(Color.DarkGray) + '/' + String(totalCaptures) +
    '  Streak: ' +
    setColor(Color.Yellow) + String(streak) +
    ' '.repeat(Math.max(0, width - 60)) +
    resetColor(),
  );
}
