// Number Station — A mysterious numbers station broadcasting encoded sequences
// Numbers encode messages using A=1, B=2 cipher. Different broadcasts per chapter.
// Player decodes the pattern and types the answer to reveal a clue.

import { Color, setColor, resetColor } from '../terminal/ansi.js';
import type { Session } from '../auth/session.js';
import type { ScreenFrame } from '../terminal/screen-frame.js';
import type { PlayerGame } from '@prisma/client';
import type { GameResult } from './game-common.js';
import {
  getChapterNumber,
  loadGameState,
  saveGameState,
  sleep,
  readKeyWithTimeout,
} from './game-common.js';

// ─── Broadcasts per chapter ─────────────────────────────────────────────────

interface Broadcast {
  numbers: number[][];   // Groups of numbers, each group is a word
  answer: string;        // The decoded message
  clue?: string;         // Clue tag to reveal on solve
  hint: string;          // Hint shown after failed attempts
  storyText: string;     // Story flavor text shown after solving
}

const BROADCASTS: Record<number, Broadcast[]> = {
  0: [
    {
      numbers: [[8, 5, 12, 12, 15], [23, 15, 18, 12, 4]],
      answer: 'HELLO WORLD',
      hint: 'Each number is a letter: A=1, B=2, C=3...',
      storyText: 'The station has been broadcasting since the BBS went online. Someone is listening.',
    },
    {
      numbers: [[7, 8, 15, 19, 20]],
      answer: 'GHOST',
      hint: 'A=1, B=2... 7=G, 8=H...',
      storyText: 'ECHO_7 used to listen to this station every night. Then one day, the broadcasts changed.',
    },
  ],
  1: [
    {
      numbers: [[13, 9, 19, 19, 9, 14, 7], [21, 19, 5, 18, 19]],
      answer: 'MISSING USERS',
      clue: 'news_disappearances',
      hint: 'Two words. A=1, Z=26. The first word has 7 letters.',
      storyText: 'Three users went silent in the last month. Their accounts are still active. Someone is logging in as them.',
    },
  ],
  2: [
    {
      numbers: [[2, 1, 19, 5, 13, 5, 14, 20], [12, 15, 7, 19]],
      answer: 'BASEMENT LOGS',
      clue: 'hidden_system_access',
      hint: 'Two words. These are hidden deep in the system.',
      storyText: 'The admin keeps a second set of logs. Below the official system log, there is another layer.',
    },
  ],
  3: [
    {
      numbers: [[20, 18, 1, 3, 5], [19, 5, 18, 22, 5, 18]],
      answer: 'TRACE SERVER',
      clue: 'server_location',
      hint: 'Two words. This is what investigators need to do.',
      storyText: 'The server bounces through three proxies. But the original IP leaked once in an old error log.',
    },
  ],
  4: [
    {
      numbers: [[1, 24, 9, 15, 13], [9, 19], [7, 21, 9, 12, 20, 25]],
      answer: 'AXIOM IS GUILTY',
      clue: 'killer_identity',
      hint: 'Three words. The truth about the sysop.',
      storyText: 'The evidence is overwhelming. Every trail leads back to one person. One alias. AXIOM.',
    },
  ],
};

// ─── Static noise characters ────────────────────────────────────────────────

const STATIC_CHARS = '.-~=+*^#@!?<>{}[]|/\\';

function randomStatic(): string {
  return STATIC_CHARS[Math.floor(Math.random() * STATIC_CHARS.length)]!;
}

function generateStaticLine(width: number): string {
  let line = '';
  for (let i = 0; i < width; i++) {
    if (Math.random() < 0.3) {
      line += ' ';
    } else {
      line += randomStatic();
    }
  }
  return line;
}

// ─── State ──────────────────────────────────────────────────────────────────

interface StationState {
  solvedBroadcasts: string[]; // answers already solved
  totalAttempts: number;
  totalSolves: number;
}

// ─── Main game ──────────────────────────────────────────────────────────────

export async function numberStation(
  session: Session,
  frame: ScreenFrame,
  game: PlayerGame,
): Promise<GameResult> {
  const terminal = session.terminal;
  const chapter = getChapterNumber(game.chapter);
  const userId = game.userId;

  // Load state
  let state = await loadGameState<StationState>('number_station', userId);
  if (!state) {
    state = { solvedBroadcasts: [], totalAttempts: 0, totalSolves: 0 };
  }

  // Get available broadcasts for current chapter and below
  const allBroadcasts: Broadcast[] = [];
  for (let ch = 0; ch <= Math.min(chapter, 4); ch++) {
    const chBroadcasts = BROADCASTS[ch];
    if (chBroadcasts) {
      for (const b of chBroadcasts) {
        if (!state.solvedBroadcasts.includes(b.answer)) {
          allBroadcasts.push(b);
        }
      }
    }
  }

  if (allBroadcasts.length === 0) {
    // All broadcasts solved
    frame.refresh(['Games', 'Number Station'], [{ key: 'Q', label: 'Back' }]);
    frame.clearContent();
    frame.skipLine();
    frame.writeContentLine(setColor(Color.DarkGray) + '  The station is silent.' + resetColor());
    frame.writeContentLine(setColor(Color.DarkGray) + '  All broadcasts have been decoded.' + resetColor());
    frame.skipLine();
    frame.writeContentLine(
      setColor(Color.LightGreen) + '  Total decodes: ' +
      setColor(Color.White) + String(state.totalSolves) + resetColor(),
    );
    frame.skipLine();
    frame.writeContentLine(setColor(Color.DarkGray) + '  Press any key...' + resetColor());
    await terminal.readKey();
    return {};
  }

  // Pick a random unsolved broadcast
  const broadcast = allBroadcasts[Math.floor(Math.random() * allBroadcasts.length)]!;

  // Setup screen
  frame.refresh(['Games', 'Number Station'], [
    { key: 'ESC', label: 'Exit' },
    { key: 'H', label: 'Hint' },
  ]);
  frame.clearContent();

  const TOP = frame.contentTop;
  const LEFT = frame.contentLeft;
  const WIDTH = frame.contentWidth;

  // Draw atmosphere header
  terminal.moveTo(TOP, LEFT);
  terminal.write(setColor(Color.DarkGray) + '  NUMBERS STATION - FREQUENCY 4625 kHz' + resetColor());
  terminal.moveTo(TOP + 1, LEFT);
  terminal.write(
    setColor(Color.DarkGray) + '  Timestamp: ' +
    setColor(Color.DarkCyan) + new Date().toISOString().replace('T', ' ').slice(0, 19) +
    resetColor(),
  );

  // Animate static noise
  terminal.hideCursor();
  for (let i = 0; i < 3; i++) {
    terminal.moveTo(TOP + 3, LEFT);
    terminal.write(setColor(Color.DarkGray) + '  ' + generateStaticLine(WIDTH - 4) + resetColor());
    await sleep(200);
  }

  // Broadcast the numbers with delays
  terminal.moveTo(TOP + 3, LEFT);
  terminal.write(' '.repeat(WIDTH));

  let displayRow = TOP + 4;
  terminal.moveTo(displayRow, LEFT);
  terminal.write(setColor(Color.Yellow) + '  >>> BROADCAST BEGIN <<<' + resetColor());
  displayRow += 2;

  for (let groupIdx = 0; groupIdx < broadcast.numbers.length; groupIdx++) {
    const group = broadcast.numbers[groupIdx]!;

    // Static between groups
    if (groupIdx > 0) {
      terminal.moveTo(displayRow, LEFT);
      terminal.write(setColor(Color.DarkGray) + '  ' + generateStaticLine(30) + resetColor());
      displayRow++;
      await sleep(800);
    }

    // Display numbers one at a time
    let numLine = '  ';
    for (let numIdx = 0; numIdx < group.length; numIdx++) {
      const num = group[numIdx]!;
      const numStr = String(num).padStart(2, ' ');

      // Check for escape key during broadcast
      const key = await readKeyWithTimeout(session, 400);
      if (key?.type === 'special' && key.value === 'ESCAPE') {
        terminal.showCursor();
        await saveGameState('number_station', userId, state);
        return {};
      }

      numLine += setColor(Color.LightCyan) + numStr + setColor(Color.DarkGray) + ' ';
    }

    terminal.moveTo(displayRow, LEFT);
    terminal.write(numLine + resetColor());
    displayRow++;

    await sleep(600);
  }

  // End of broadcast
  displayRow++;
  terminal.moveTo(displayRow, LEFT);
  terminal.write(setColor(Color.Yellow) + '  >>> BROADCAST END <<<' + resetColor());
  displayRow += 2;

  // Static noise after broadcast
  terminal.moveTo(displayRow, LEFT);
  terminal.write(setColor(Color.DarkGray) + '  ' + generateStaticLine(WIDTH - 4) + resetColor());
  displayRow += 2;

  // Input area
  terminal.showCursor();
  let attempts = 0;
  const maxAttempts = 5;
  let solved = false;
  let resultClue: string | undefined;
  let resultSecret: string | undefined;

  while (attempts < maxAttempts && !solved) {
    terminal.moveTo(displayRow, LEFT);
    terminal.write(
      setColor(Color.DarkCyan) + '  Decode' +
      setColor(Color.DarkGray) + ' [' + String(maxAttempts - attempts) + ' left]' +
      setColor(Color.DarkCyan) + ': ' +
      setColor(Color.White),
    );

    const answer = await terminal.readLine({ maxLength: 40 });

    if (answer.trim() === '') {
      // Check for escape
      terminal.showCursor();
      await saveGameState('number_station', userId, state);
      return {};
    }

    state.totalAttempts++;
    attempts++;

    if (answer.trim().toUpperCase() === broadcast.answer) {
      // Correct!
      solved = true;
      state.totalSolves++;
      state.solvedBroadcasts.push(broadcast.answer);
      resultClue = broadcast.clue;
      resultSecret = broadcast.storyText;

      displayRow++;
      terminal.moveTo(displayRow, LEFT);
      terminal.write(
        setColor(Color.LightGreen) + '  === TRANSMISSION DECODED ===' + resetColor(),
      );
      displayRow += 2;

      // Show story text
      const storyWords = broadcast.storyText.split(' ');
      let line = '  ';
      for (const word of storyWords) {
        if (line.length + word.length + 1 > WIDTH - 2) {
          terminal.moveTo(displayRow, LEFT);
          terminal.write(setColor(Color.LightGreen) + line + resetColor());
          displayRow++;
          line = '  ' + word;
        } else {
          line += (line.length > 2 ? ' ' : '') + word;
        }
      }
      if (line.length > 2) {
        terminal.moveTo(displayRow, LEFT);
        terminal.write(setColor(Color.LightGreen) + line + resetColor());
        displayRow++;
      }

      displayRow++;
      terminal.moveTo(displayRow, LEFT);
      terminal.write(setColor(Color.DarkGray) + '  Press any key to continue...' + resetColor());
      await terminal.readKey();
    } else {
      terminal.moveTo(displayRow + 1, LEFT);
      terminal.write(setColor(Color.LightRed) + '  Incorrect decode.' + resetColor());

      // Show hint after 2 failed attempts or if player presses H
      if (attempts >= 2) {
        terminal.moveTo(displayRow + 2, LEFT);
        terminal.write(
          setColor(Color.DarkGray) + '  Hint: ' +
          setColor(Color.Yellow) + broadcast.hint +
          resetColor(),
        );
      }

      displayRow += 3;

      // Safety: don't let displayRow exceed bottom
      if (displayRow > frame.contentBottom - 3) {
        terminal.moveTo(frame.contentBottom - 1, LEFT);
        terminal.write(setColor(Color.DarkGray) + '  Press any key...' + resetColor());
        await terminal.readKey();
        break;
      }
    }
  }

  // Save state
  await saveGameState('number_station', userId, state);

  return { secretFound: resultSecret, clueRevealed: resultClue };
}
