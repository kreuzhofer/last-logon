// Memory Sequence — Simon-says style game
// Terminal flashes colored characters at positions; player repeats the sequence.
// At certain levels, "glitches" appear with hidden messages.

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
} from './game-common.js';

// ─── Sequence elements ──────────────────────────────────────────────────────

interface SeqElement {
  symbol: string;
  color: Color;
  key: string;    // The key the player presses to match
}

const ELEMENTS: SeqElement[] = [
  { symbol: '\u2588', color: Color.LightRed,     key: 'R' },  // Red block
  { symbol: '\u2588', color: Color.LightGreen,   key: 'G' },  // Green block
  { symbol: '\u2588', color: Color.LightBlue,    key: 'B' },  // Blue block
  { symbol: '\u2588', color: Color.Yellow,        key: 'Y' },  // Yellow block
];

// ─── Glitch messages per chapter ────────────────────────────────────────────

interface GlitchMessage {
  level: number;
  text: string;
  clue?: string;
}

const GLITCH_MESSAGES: Record<number, GlitchMessage[]> = {
  0: [
    { level: 5,  text: 'ECHO_7 WAS HERE' },
    { level: 8,  text: 'THE SYSOP SEES ALL' },
    { level: 12, text: 'CHECK /var/log/hidden' },
  ],
  1: [
    { level: 5,  text: 'NIGHTOWL KNOWS' },
    { level: 8,  text: 'ROT13: NKVBZ VF JNGPUVAT' },
    { level: 12, text: 'DISAPPEARANCES: 3 USERS THIS MONTH' },
  ],
  2: [
    { level: 5,  text: 'D_COLE IS INVESTIGATING', clue: 'police_investigation' },
    { level: 8,  text: 'ACCESS LEVEL 255 = GOD MODE' },
    { level: 12, text: 'BASEMENT SERVER ROOM: 47.3812 N, 8.5417 E' },
  ],
  3: [
    { level: 5,  text: 'ENCRYPTED LOGS DECRYPTED' },
    { level: 8,  text: 'SERVER IP: 10.13.37.1 BEHIND 3 PROXIES', clue: 'server_location' },
    { level: 12, text: '/home/axiom/.secrets/victims.log' },
  ],
  4: [
    { level: 5,  text: 'EVIDENCE ASSEMBLED' },
    { level: 8,  text: 'AXIOM = SYSOP = KILLER' },
    { level: 12, text: 'FINAL FILE: /home/axiom/.secrets/manifest.txt', clue: 'killer_identity' },
  ],
};

// ─── State ──────────────────────────────────────────────────────────────────

interface MemoryState {
  highScore: number;
  glitchesFound: string[];
  totalGames: number;
}

// ─── Display positions for the 4 color blocks ──────────────────────────────

function getBlockPositions(top: number, left: number, width: number): Array<{ row: number; col: number }> {
  const centerCol = left + Math.floor(width / 2);
  const centerRow = top + 8;
  return [
    { row: centerRow - 3, col: centerCol },     // Top (Red)
    { row: centerRow,     col: centerCol - 12 }, // Left (Green)
    { row: centerRow,     col: centerCol + 12 }, // Right (Blue)
    { row: centerRow + 3, col: centerCol },      // Bottom (Yellow)
  ];
}

// ─── Main game ──────────────────────────────────────────────────────────────

export async function memorySequence(
  session: Session,
  frame: ScreenFrame,
  game: PlayerGame,
): Promise<GameResult> {
  const terminal = session.terminal;
  const chapter = getChapterNumber(game.chapter);
  const userId = game.userId;

  // Load state
  let state = await loadGameState<MemoryState>('memory_sequence', userId);
  if (!state) {
    state = { highScore: 0, glitchesFound: [], totalGames: 0 };
  }
  state.totalGames++;

  const glitchDefs = GLITCH_MESSAGES[Math.min(chapter, 4)] ?? GLITCH_MESSAGES[0]!;

  // Setup screen
  frame.refresh(['Games', 'Memory Sequence'], [
    { key: 'R', label: 'Red' },
    { key: 'G', label: 'Green' },
    { key: 'B', label: 'Blue' },
    { key: 'Y', label: 'Yellow' },
    { key: 'ESC', label: 'Exit' },
  ]);
  frame.clearContent();

  const TOP = frame.contentTop;
  const LEFT = frame.contentLeft;
  const WIDTH = frame.contentWidth;
  const positions = getBlockPositions(TOP, LEFT, WIDTH);

  // Draw instructions
  terminal.moveTo(TOP, LEFT);
  terminal.write(setColor(Color.LightCyan) + '  MEMORY SEQUENCE' + resetColor());
  terminal.moveTo(TOP + 1, LEFT);
  terminal.write(
    setColor(Color.DarkGray) +
    '  Watch the sequence, then repeat it. [R]ed [G]reen [B]lue [Y]ellow' +
    resetColor(),
  );

  // Draw the 4 blocks in their resting state
  drawBlocks(terminal, positions, -1);

  // Draw legend
  for (let i = 0; i < ELEMENTS.length; i++) {
    const elem = ELEMENTS[i]!;
    const pos = positions[i]!;
    terminal.moveTo(pos.row + 1, pos.col - 1);
    terminal.write(setColor(Color.DarkGray) + `[${elem.key}]` + resetColor());
  }

  // Game loop
  const sequence: number[] = [];
  let level = 1;
  let gameOver = false;
  let resultClue: string | undefined;
  let resultSecret: string | undefined;

  while (!gameOver) {
    // Status
    drawLevelStatus(terminal, TOP + 15, LEFT, WIDTH, level, state.highScore);

    // Add a new element to the sequence
    sequence.push(Math.floor(Math.random() * 4));

    await sleep(600);

    // Check for glitch at this level
    const glitch = glitchDefs.find(g => g.level === level && !state!.glitchesFound.includes(g.text));
    if (glitch) {
      // Show glitch effect!
      await showGlitch(terminal, frame, glitch.text, TOP, LEFT, WIDTH);
      state.glitchesFound.push(glitch.text);
      if (glitch.clue) {
        resultClue = glitch.clue;
      }
      resultSecret = `Memory glitch at level ${level}: "${glitch.text}"`;
    }

    // Play the sequence
    terminal.hideCursor();
    for (const elemIdx of sequence) {
      drawBlocks(terminal, positions, elemIdx);
      await sleep(Math.max(200, 600 - level * 30));
      drawBlocks(terminal, positions, -1);
      await sleep(150);
    }

    // Player repeats the sequence
    terminal.moveTo(TOP + 17, LEFT);
    terminal.write(
      setColor(Color.LightCyan) + '  Your turn! ' +
      setColor(Color.DarkGray) + `(${sequence.length} steps)` +
      ' '.repeat(30) +
      resetColor(),
    );

    terminal.showCursor();

    for (let step = 0; step < sequence.length; step++) {
      const expected = sequence[step]!;
      const expectedElem = ELEMENTS[expected]!;

      // Show progress dots
      terminal.moveTo(TOP + 18, LEFT + 2);
      let progress = '';
      for (let d = 0; d < sequence.length; d++) {
        if (d < step) {
          progress += setColor(Color.LightGreen) + '\u2022 ';
        } else if (d === step) {
          progress += setColor(Color.White) + '? ';
        } else {
          progress += setColor(Color.DarkGray) + '\u2022 ';
        }
      }
      terminal.write(progress + resetColor());

      // Wait for input
      const key = await terminal.readHotkey(['R', 'G', 'B', 'Y', 'ESCAPE']);

      if (key === 'ESCAPE') {
        gameOver = true;
        break;
      }

      if (key === expectedElem.key) {
        // Correct — flash the block
        terminal.hideCursor();
        drawBlocks(terminal, positions, expected);
        await sleep(200);
        drawBlocks(terminal, positions, -1);
        terminal.showCursor();
      } else {
        // Wrong — game over
        terminal.hideCursor();

        // Flash the correct one red
        terminal.moveTo(TOP + 17, LEFT);
        terminal.write(
          setColor(Color.LightRed) +
          `  Wrong! Expected [${expectedElem.key}]` +
          ' '.repeat(40) +
          resetColor(),
        );

        // Flash error effect
        drawBlocks(terminal, positions, expected);
        await sleep(500);
        drawBlocks(terminal, positions, -1);

        gameOver = true;
        break;
      }
    }

    if (!gameOver) {
      // Level complete
      terminal.moveTo(TOP + 17, LEFT);
      terminal.write(
        setColor(Color.LightGreen) + `  Level ${level} complete!` +
        ' '.repeat(40) +
        resetColor(),
      );
      level++;
    }
  }

  // Final score
  const finalScore = level - 1;
  if (finalScore > state.highScore) {
    state.highScore = finalScore;
  }

  // Level 15 bonus secret
  if (finalScore >= 15 && !state.glitchesFound.includes('LEVEL_15_SECRET')) {
    state.glitchesFound.push('LEVEL_15_SECRET');
    resultSecret = 'Memory mastery achieved. Hidden file path revealed: /home/axiom/.secrets/manifest.txt';
    resultClue = resultClue ?? 'hidden_file_path';
  }

  // Show game over screen
  frame.clearContent();
  frame.setBreadcrumb('Games', 'Memory Sequence', 'Game Over');
  frame.skipLine();
  frame.writeContentLine(setColor(Color.LightCyan) + '  MEMORY SEQUENCE - RESULTS' + resetColor());
  frame.skipLine();
  frame.writeContentLine(
    setColor(Color.DarkGray) + '  Level reached: ' +
    setColor(Color.White) + String(finalScore) + resetColor(),
  );
  frame.writeContentLine(
    setColor(Color.DarkGray) + '  High score:    ' +
    setColor(Color.Yellow) + String(state.highScore) + resetColor(),
  );
  frame.writeContentLine(
    setColor(Color.DarkGray) + '  Total games:   ' +
    setColor(Color.LightGray) + String(state.totalGames) + resetColor(),
  );
  frame.writeContentLine(
    setColor(Color.DarkGray) + '  Glitches seen: ' +
    setColor(Color.LightMagenta) + String(state.glitchesFound.length) + resetColor(),
  );

  if (resultSecret) {
    frame.skipLine();
    frame.writeContentLine(setColor(Color.Yellow) + '  >> GLITCH DATA CAPTURED <<' + resetColor());
    frame.writeContentLine(setColor(Color.LightGreen) + '  ' + resultSecret + resetColor());
  }

  frame.skipLine();
  frame.writeContentLine(setColor(Color.DarkGray) + '  Press any key...' + resetColor());
  terminal.showCursor();
  await terminal.readKey();

  // Save
  await saveGameState('memory_sequence', userId, state);
  if (finalScore > 0) {
    await saveHighScore('memory_sequence', userId, session.handle, finalScore);
  }

  return { secretFound: resultSecret, clueRevealed: resultClue };
}

// ─── Drawing helpers ────────────────────────────────────────────────────────

function drawBlocks(
  terminal: import('../terminal/terminal.js').Terminal,
  positions: Array<{ row: number; col: number }>,
  activeIdx: number,
): void {
  for (let i = 0; i < ELEMENTS.length; i++) {
    const elem = ELEMENTS[i]!;
    const pos = positions[i]!;
    const isActive = i === activeIdx;

    // Draw a 5-char wide block
    const blockChar = isActive ? '\u2588\u2588\u2588\u2588\u2588' : '\u2591\u2591\u2591\u2591\u2591';
    const color = isActive ? elem.color : Color.DarkGray;

    terminal.moveTo(pos.row, pos.col - 2);
    terminal.write(setColor(color) + blockChar + resetColor());
  }
}

function drawLevelStatus(
  terminal: import('../terminal/terminal.js').Terminal,
  row: number,
  left: number,
  width: number,
  level: number,
  highScore: number,
): void {
  terminal.moveTo(row, left);
  terminal.write(
    setColor(Color.DarkGray) + '  Level: ' +
    setColor(Color.White) + String(level) +
    setColor(Color.DarkGray) + '  |  High Score: ' +
    setColor(Color.Yellow) + String(highScore) +
    ' '.repeat(Math.max(0, width - 40)) +
    resetColor(),
  );
}

async function showGlitch(
  terminal: import('../terminal/terminal.js').Terminal,
  frame: ScreenFrame,
  message: string,
  top: number,
  left: number,
  width: number,
): Promise<void> {
  // Brief screen corruption effect
  terminal.hideCursor();
  const GLITCH_CHARS = '@#$%&*!?~=+<>{}[]|/\\^';

  for (let flash = 0; flash < 3; flash++) {
    // Fill a few rows with glitch characters
    for (let r = 0; r < 4; r++) {
      const row = top + 4 + r + Math.floor(Math.random() * 8);
      if (row > frame.contentBottom - 3) continue;
      terminal.moveTo(row, left);
      let glitchLine = '';
      for (let c = 0; c < width; c++) {
        glitchLine += GLITCH_CHARS[Math.floor(Math.random() * GLITCH_CHARS.length)]!;
      }
      terminal.write(setColor(Color.LightRed) + glitchLine + resetColor());
    }
    await sleep(80);
  }

  // Flash the hidden message
  const msgRow = top + 8;
  const msgCol = left + Math.floor((width - message.length) / 2);
  terminal.moveTo(msgRow, msgCol);
  terminal.write(setColor(Color.White, Color.DarkRed) + ' ' + message + ' ' + resetColor());

  await sleep(1500);

  // Clear the glitch
  for (let r = top + 2; r <= frame.contentBottom - 5; r++) {
    terminal.moveTo(r, left);
    terminal.write(' '.repeat(width));
  }
  terminal.showCursor();
}
