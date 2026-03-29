// Worm — Classic Snake/Worm game in ASCII
// As the worm eats food, letters are collected that spell out a story-relevant message.
// Arrow keys to move, walls kill, self-collision kills.

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

// ─── Message words per chapter ──────────────────────────────────────────────
// Each letter collected spells out a word. When enough letters are gathered,
// the message is revealed.

interface WormMessage {
  word: string;       // The word to spell out
  storyText: string;  // Story text revealed after spelling the word
  clue?: string;      // Optional clue reward
}

const WORM_MESSAGES: Record<number, WormMessage[]> = {
  0: [
    { word: 'AXIOM', storyText: 'The sysop goes by AXIOM. A strange name for someone running a BBS.' },
    { word: 'GHOST', storyText: 'Ghost users linger in the system. Their accounts are active but nobody is home.' },
  ],
  1: [
    { word: 'CIPHER', storyText: 'AXIOM loves ciphers. Everything is a puzzle to him. Even the disappearances.' },
    { word: 'FRIDAY', storyText: 'Disappearances always happen on Fridays. The last three users all logged off on a Friday night.' },
  ],
  2: [
    { word: 'ACCESS', storyText: 'Access level 255 opens everything. The admin can see all. Read all. Delete all.', clue: 'hidden_system_access' },
    { word: 'DCOLE', storyText: 'D_COLE has been asking questions. An investigator masquerading as a regular user.' },
  ],
  3: [
    { word: 'SERVER', storyText: 'The server is local. Not in some data center. In a basement. In a house.', clue: 'server_location' },
    { word: 'TRACED', storyText: 'The proxy chain has been traced. Three hops, all leading back to the same subnet.' },
  ],
  4: [
    { word: 'KILLER', storyText: 'AXIOM is the killer. The evidence is undeniable. The question is: can you prove it?', clue: 'killer_identity' },
    { word: 'TRUTH', storyText: 'The truth was hidden in plain sight. Every message, every log, every puzzle pointed here.' },
  ],
};

// ─── Direction ──────────────────────────────────────────────────────────────

enum Dir { UP, DOWN, LEFT, RIGHT }

interface Point { x: number; y: number; }

// ─── State ──────────────────────────────────────────────────────────────────

interface WormState {
  highScore: number;
  wordsSpelled: string[];
  totalGames: number;
}

// ─── Main game ──────────────────────────────────────────────────────────────

export async function wormGame(
  session: Session,
  frame: ScreenFrame,
  game: PlayerGame,
): Promise<GameResult> {
  const terminal = session.terminal;
  const chapter = getChapterNumber(game.chapter);
  const userId = game.userId;

  // Load state
  let state = await loadGameState<WormState>('worm', userId);
  if (!state) {
    state = { highScore: 0, wordsSpelled: [], totalGames: 0 };
  }
  state.totalGames++;

  // Pick a message word for this session
  const chapterKey = Math.min(chapter, 4);
  const messages = WORM_MESSAGES[chapterKey] ?? WORM_MESSAGES[0]!;
  // Prefer unspelled words
  const unspelled = messages.filter(m => !state!.wordsSpelled.includes(m.word));
  const messageData = unspelled.length > 0
    ? unspelled[Math.floor(Math.random() * unspelled.length)]!
    : messages[Math.floor(Math.random() * messages.length)]!;
  const targetWord = messageData.word;

  // Setup screen
  frame.refresh(['Games', 'Worm'], [
    { key: '\u2190\u2191\u2192\u2193', label: 'Move' },
    { key: 'ESC', label: 'Exit' },
  ]);
  frame.clearContent();

  const TOP = frame.contentTop;
  const LEFT = frame.contentLeft;
  const WIDTH = frame.contentWidth;
  const HEIGHT = frame.contentHeight;

  // Play area: leave 2 rows at top for status, 1 at bottom
  const FIELD_TOP = TOP + 2;
  const FIELD_LEFT = LEFT;
  const FIELD_WIDTH = WIDTH;
  const FIELD_HEIGHT = HEIGHT - 3;

  // Draw walls
  drawWalls(terminal, FIELD_TOP, FIELD_LEFT, FIELD_WIDTH, FIELD_HEIGHT);

  // Initialize worm in center
  const startX = Math.floor(FIELD_WIDTH / 2);
  const startY = Math.floor(FIELD_HEIGHT / 2);
  const body: Point[] = [
    { x: startX, y: startY },
    { x: startX - 1, y: startY },
    { x: startX - 2, y: startY },
  ];
  let direction = Dir.RIGHT;
  let nextDirection = Dir.RIGHT;

  // Letter collection tracking
  let letterIndex = 0; // Next letter to collect from targetWord
  const collected: string[] = [];

  // Place first food
  let food = placeFood(FIELD_WIDTH, FIELD_HEIGHT, body, targetWord[letterIndex]!);

  // Draw initial food
  drawFood(terminal, FIELD_TOP, FIELD_LEFT, food, targetWord[letterIndex]!);

  // Draw initial worm
  drawWorm(terminal, FIELD_TOP, FIELD_LEFT, body);

  // Score
  let score = 0;
  let gameOver = false;
  let tickDelay = 120; // ms per tick (gets faster)
  let resultSecret: string | undefined;
  let resultClue: string | undefined;

  terminal.hideCursor();

  // Draw initial status
  drawWormStatus(terminal, TOP, LEFT, WIDTH, score, collected.join(''), targetWord);

  while (!gameOver) {
    // Check for input (non-blocking, shorter timeout for responsiveness)
    const key = await readKeyWithTimeout(session, tickDelay);

    if (key) {
      if (key.type === 'special' && key.value === 'ESCAPE') {
        gameOver = true;
        break;
      }
      if (key.type === 'special') {
        switch (key.value) {
          case 'UP':
            if (direction !== Dir.DOWN) nextDirection = Dir.UP;
            break;
          case 'DOWN':
            if (direction !== Dir.UP) nextDirection = Dir.DOWN;
            break;
          case 'LEFT':
            if (direction !== Dir.RIGHT) nextDirection = Dir.LEFT;
            break;
          case 'RIGHT':
            if (direction !== Dir.LEFT) nextDirection = Dir.RIGHT;
            break;
        }
      }
    }

    direction = nextDirection;

    // Calculate new head position
    const head = body[0]!;
    let newHead: Point;
    switch (direction) {
      case Dir.UP:    newHead = { x: head.x, y: head.y - 1 }; break;
      case Dir.DOWN:  newHead = { x: head.x, y: head.y + 1 }; break;
      case Dir.LEFT:  newHead = { x: head.x - 1, y: head.y }; break;
      case Dir.RIGHT: newHead = { x: head.x + 1, y: head.y }; break;
    }

    // Check wall collision (field is 1-indexed inside walls)
    if (newHead.x <= 0 || newHead.x >= FIELD_WIDTH - 1 ||
        newHead.y <= 0 || newHead.y >= FIELD_HEIGHT - 1) {
      gameOver = true;
      // Flash collision
      terminal.moveTo(FIELD_TOP + newHead.y, FIELD_LEFT + newHead.x);
      terminal.write(setColor(Color.LightRed) + 'X' + resetColor());
      continue;
    }

    // Check self collision
    if (body.some(seg => seg.x === newHead.x && seg.y === newHead.y)) {
      gameOver = true;
      terminal.moveTo(FIELD_TOP + newHead.y, FIELD_LEFT + newHead.x);
      terminal.write(setColor(Color.LightRed) + 'X' + resetColor());
      continue;
    }

    // Check food
    let ate = false;
    if (newHead.x === food.x && newHead.y === food.y) {
      ate = true;
      score += 10;

      // Collect the letter
      if (letterIndex < targetWord.length) {
        collected.push(targetWord[letterIndex]!);
        letterIndex++;
      }

      // Speed up slightly
      if (tickDelay > 50) {
        tickDelay -= 3;
      }
    }

    // Move worm
    body.unshift(newHead);

    if (!ate) {
      // Remove tail
      const tail = body.pop()!;
      terminal.moveTo(FIELD_TOP + tail.y, FIELD_LEFT + tail.x);
      terminal.write(' ');
    }

    // Draw worm
    drawWorm(terminal, FIELD_TOP, FIELD_LEFT, body);

    // Place new food if eaten
    if (ate) {
      if (letterIndex < targetWord.length) {
        food = placeFood(FIELD_WIDTH, FIELD_HEIGHT, body, targetWord[letterIndex]!);
        drawFood(terminal, FIELD_TOP, FIELD_LEFT, food, targetWord[letterIndex]!);
      } else {
        // Word complete! Place generic food
        food = placeFood(FIELD_WIDTH, FIELD_HEIGHT, body, '*');
        drawFood(terminal, FIELD_TOP, FIELD_LEFT, food, '*');
        score += 50; // Bonus for completing the word
      }
    }

    // Update status
    drawWormStatus(terminal, TOP, LEFT, WIDTH, score, collected.join(''), targetWord);

    // Check if word is complete (first time)
    if (letterIndex >= targetWord.length && !state.wordsSpelled.includes(targetWord)) {
      state.wordsSpelled.push(targetWord);
      resultSecret = messageData.storyText;
      resultClue = messageData.clue;

      // Brief flash notification
      terminal.moveTo(TOP + 1, LEFT);
      terminal.write(
        setColor(Color.Yellow) + '  WORD COMPLETE: ' +
        setColor(Color.White) + targetWord + '!' +
        ' '.repeat(Math.max(0, WIDTH - targetWord.length - 20)) +
        resetColor(),
      );
      // Don't break; let the player keep playing for high score
    }
  }

  terminal.showCursor();

  // Update high score
  if (score > state.highScore) {
    state.highScore = score;
  }

  // Game over screen
  frame.clearContent();
  frame.setBreadcrumb('Games', 'Worm', 'Game Over');
  frame.skipLine();
  frame.writeContentLine(setColor(Color.LightCyan) + '  WORM - GAME OVER' + resetColor());
  frame.skipLine();
  frame.writeContentLine(
    setColor(Color.DarkGray) + '  Score:      ' +
    setColor(Color.White) + String(score) + resetColor(),
  );
  frame.writeContentLine(
    setColor(Color.DarkGray) + '  High score: ' +
    setColor(Color.Yellow) + String(state.highScore) + resetColor(),
  );
  frame.writeContentLine(
    setColor(Color.DarkGray) + '  Length:     ' +
    setColor(Color.LightGray) + String(body.length) + resetColor(),
  );
  frame.writeContentLine(
    setColor(Color.DarkGray) + '  Letters:    ' +
    setColor(Color.LightCyan) + collected.join('') +
    (letterIndex < targetWord.length
      ? setColor(Color.DarkGray) + targetWord.slice(letterIndex)
      : '') +
    resetColor(),
  );

  if (resultSecret) {
    frame.skipLine();
    frame.writeContentLine(setColor(Color.Yellow) + '  === SECRET MESSAGE ===' + resetColor());
    // Word wrap the story text
    const storyWords = resultSecret.split(' ');
    let line = '  ';
    for (const word of storyWords) {
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
  }

  frame.skipLine();
  frame.writeContentLine(
    setColor(Color.DarkGray) + '  Words found: ' +
    setColor(Color.LightMagenta) + String(state.wordsSpelled.length) + resetColor(),
  );
  frame.writeContentLine(
    setColor(Color.DarkGray) + '  Total games: ' +
    setColor(Color.LightGray) + String(state.totalGames) + resetColor(),
  );

  frame.skipLine();
  frame.writeContentLine(setColor(Color.DarkGray) + '  Press any key...' + resetColor());
  await terminal.readKey();

  // Save
  await saveGameState('worm', userId, state);
  if (score > 0) {
    await saveHighScore('worm', userId, session.handle, score);
  }

  return { secretFound: resultSecret, clueRevealed: resultClue };
}

// ─── Drawing helpers ────────────────────────────────────────────────────────

function drawWalls(
  terminal: import('../terminal/terminal.js').Terminal,
  fieldTop: number,
  fieldLeft: number,
  fieldWidth: number,
  fieldHeight: number,
): void {
  // Top wall
  terminal.moveTo(fieldTop, fieldLeft);
  terminal.write(setColor(Color.DarkGray) + '#'.repeat(fieldWidth) + resetColor());

  // Bottom wall
  terminal.moveTo(fieldTop + fieldHeight - 1, fieldLeft);
  terminal.write(setColor(Color.DarkGray) + '#'.repeat(fieldWidth) + resetColor());

  // Side walls
  for (let y = 1; y < fieldHeight - 1; y++) {
    terminal.moveTo(fieldTop + y, fieldLeft);
    terminal.write(setColor(Color.DarkGray) + '#' + resetColor());
    terminal.moveTo(fieldTop + y, fieldLeft + fieldWidth - 1);
    terminal.write(setColor(Color.DarkGray) + '#' + resetColor());
  }
}

function drawWorm(
  terminal: import('../terminal/terminal.js').Terminal,
  fieldTop: number,
  fieldLeft: number,
  body: Point[],
): void {
  // Head
  const head = body[0]!;
  terminal.moveTo(fieldTop + head.y, fieldLeft + head.x);
  terminal.write(setColor(Color.LightGreen) + '@' + resetColor());

  // Body
  for (let i = 1; i < body.length; i++) {
    const seg = body[i]!;
    terminal.moveTo(fieldTop + seg.y, fieldLeft + seg.x);
    terminal.write(setColor(Color.DarkGreen) + 'o' + resetColor());
  }
}

function drawFood(
  terminal: import('../terminal/terminal.js').Terminal,
  fieldTop: number,
  fieldLeft: number,
  pos: Point,
  letter: string,
): void {
  terminal.moveTo(fieldTop + pos.y, fieldLeft + pos.x);
  terminal.write(setColor(Color.Yellow) + letter + resetColor());
}

function placeFood(
  fieldWidth: number,
  fieldHeight: number,
  body: Point[],
  _letter: string,
): Point {
  // Place food randomly, avoiding the worm body and walls
  let attempts = 0;
  while (attempts < 1000) {
    const x = 1 + Math.floor(Math.random() * (fieldWidth - 2));
    const y = 1 + Math.floor(Math.random() * (fieldHeight - 2));
    if (!body.some(seg => seg.x === x && seg.y === y)) {
      return { x, y };
    }
    attempts++;
  }
  // Fallback: just pick a spot
  return { x: Math.floor(fieldWidth / 2), y: Math.floor(fieldHeight / 2) };
}

function drawWormStatus(
  terminal: import('../terminal/terminal.js').Terminal,
  top: number,
  left: number,
  width: number,
  score: number,
  collected: string,
  targetWord: string,
): void {
  terminal.moveTo(top, left);

  // Show collected letters with remaining as dim
  let letterDisplay = '';
  for (let i = 0; i < targetWord.length; i++) {
    if (i < collected.length) {
      letterDisplay += setColor(Color.LightCyan) + targetWord[i]!;
    } else {
      letterDisplay += setColor(Color.DarkGray) + '_';
    }
  }

  terminal.write(
    setColor(Color.DarkGray) + '  Score: ' +
    setColor(Color.White) + String(score).padStart(5) +
    setColor(Color.DarkGray) + '  |  Word: ' +
    letterDisplay +
    ' '.repeat(Math.max(0, width - 35 - targetWord.length)) +
    resetColor(),
  );
}
