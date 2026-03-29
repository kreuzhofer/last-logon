// Games Menu — Entry point for all mini-games
// Shows available games based on chapter progression and handles secret/clue integration.

import { Color, setColor, resetColor } from '../terminal/ansi.js';
import { padRight } from '../utils/string-utils.js';
import type { Session } from '../auth/session.js';
import type { ScreenFrame, HotkeyDef } from '../terminal/screen-frame.js';
import type { PlayerGame } from '@prisma/client';
import { addClue, addGameEvent, createNotification, getPlayerGame } from '../game/game-layer.js';
import { createChildLogger } from '../core/logger.js';
import { getChapterNumber } from './game-common.js';
import type { GameResult } from './game-common.js';

// Game imports
import { matrixRain } from './matrix-rain.js';
import { numberStation } from './number-station.js';
import { memorySequence } from './memory-sequence.js';
import { hackFirewall } from './firewall.js';
import { wormGame } from './worm.js';

const log = createChildLogger('games');

// ─── Game definitions ───────────────────────────────────────────────────────

interface GameDef {
  key: string;
  name: string;
  description: string;
  minChapter: number;  // Minimum chapter to unlock
  run: (session: Session, frame: ScreenFrame, game: PlayerGame) => Promise<GameResult>;
}

const ALL_GAMES: GameDef[] = [
  {
    key: '1',
    name: 'Matrix Rain',
    description: 'Watch the rain. Spot the words. Capture the truth.',
    minChapter: 0,
    run: matrixRain,
  },
  {
    key: '2',
    name: 'Number Station',
    description: 'Decode mysterious number broadcasts. A=1, B=2...',
    minChapter: 1,
    run: numberStation,
  },
  {
    key: '3',
    name: 'Memory Sequence',
    description: 'Simon says... but the glitches say more.',
    minChapter: 2,
    run: memorySequence,
  },
  {
    key: '4',
    name: 'Hack the Firewall',
    description: 'Capture data packets. Decrypt the hidden message.',
    minChapter: 2,
    run: hackFirewall,
  },
  {
    key: '5',
    name: 'Worm',
    description: 'Classic snake game. Eat letters, spell secrets.',
    minChapter: 3,
    run: wormGame,
  },
];

// ─── Games Menu ─────────────────────────────────────────────────────────────

export async function gamesMenu(
  session: Session,
  frame: ScreenFrame,
  game: PlayerGame,
): Promise<void> {
  const terminal = session.terminal;
  const chapter = getChapterNumber(game.chapter);

  while (true) {
    // Get available games for current chapter
    const available = ALL_GAMES.filter(g => chapter >= g.minChapter);

    if (available.length === 0) {
      frame.refresh(['Games'], [{ key: 'Q', label: 'Back' }]);
      frame.clearContent();
      frame.skipLine();
      frame.writeContentLine(
        setColor(Color.DarkGray) + '  No games available yet.' + resetColor(),
      );
      frame.writeContentLine(
        setColor(Color.DarkGray) + '  Keep exploring the BBS...' + resetColor(),
      );
      frame.skipLine();
      frame.writeContentLine(setColor(Color.DarkGray) + '  Press any key...' + resetColor());
      await terminal.readKey();
      return;
    }

    // Build hotkey set
    const hotkeys: HotkeyDef[] = available.map(g => ({ key: g.key, label: g.name }));
    hotkeys.push({ key: 'Q', label: 'Back' });
    const validKeys = [...available.map(g => g.key), 'Q'];

    // Draw menu
    frame.refresh(['Games'], hotkeys);
    frame.clearContent();
    frame.skipLine();

    // Title
    frame.writeContentLine(
      setColor(Color.LightCyan) +
      '          D O O R   G A M E S' +
      resetColor(),
    );
    frame.skipLine();

    // Subtitle
    frame.writeContentLine(
      setColor(Color.DarkGray) +
      '  Each game hides secrets. Play carefully.' +
      resetColor(),
    );
    frame.skipLine();

    // List games
    for (const gameDef of available) {
      frame.writeContentLine(
        setColor(Color.DarkCyan) + '  [' +
        setColor(Color.White) + gameDef.key +
        setColor(Color.DarkCyan) + '] ' +
        setColor(Color.LightGreen) + padRight(gameDef.name, 20) +
        setColor(Color.DarkGray) + gameDef.description +
        resetColor(),
      );
    }

    // Show locked games as teasers
    const locked = ALL_GAMES.filter(g => chapter < g.minChapter);
    if (locked.length > 0) {
      frame.skipLine();
      frame.writeContentLine(
        setColor(Color.DarkGray) + '  --- LOCKED ---' + resetColor(),
      );
      for (const gameDef of locked) {
        frame.writeContentLine(
          setColor(Color.DarkGray) + '  [' + gameDef.key + '] ' +
          padRight(gameDef.name, 20) +
          '(Requires further progression)' +
          resetColor(),
        );
      }
    }

    frame.skipLine();

    // Prompt
    terminal.moveTo(frame.currentRow, frame.contentLeft);
    terminal.write(
      setColor(Color.LightCyan) + '  Select game' +
      setColor(Color.DarkGray) + ': ' +
      setColor(Color.White),
    );

    const choice = await terminal.readHotkey(validKeys);

    if (choice === 'Q') return;

    // Find and run the selected game
    const selectedGame = available.find(g => g.key === choice);
    if (!selectedGame) continue;

    try {
      // Reload game state before running (might have changed)
      const freshGame = await getPlayerGame(game.userId);
      if (!freshGame) continue;

      log.info({ userId: game.userId, game: selectedGame.name }, 'Starting mini-game');

      const result = await selectedGame.run(session, frame, freshGame);

      // Process results
      await processGameResult(result, freshGame, session);

      // Reload game state after game (clues may have been added)
      const updatedGame = await getPlayerGame(game.userId);
      if (updatedGame) {
        // Update the reference for next loop iteration
        Object.assign(game, updatedGame);
      }
    } catch (err) {
      log.error({ error: err, game: selectedGame.name }, 'Error in mini-game');
      // Don't crash the menu; just show error and continue
      frame.clearContent();
      frame.skipLine();
      frame.writeContentLine(
        setColor(Color.LightRed) + '  Game error. Returning to menu...' + resetColor(),
      );
      frame.skipLine();
      frame.writeContentLine(setColor(Color.DarkGray) + '  Press any key...' + resetColor());
      await terminal.readKey();
    }
  }
}

// ─── Process game results ───────────────────────────────────────────────────

async function processGameResult(
  result: GameResult,
  game: PlayerGame,
  session: Session,
): Promise<void> {
  if (!result.secretFound && !result.clueRevealed) return;

  // Add clue if revealed
  if (result.clueRevealed) {
    try {
      await addClue(game, result.clueRevealed);
      log.info({ userId: game.userId, clue: result.clueRevealed }, 'Clue revealed via mini-game');
    } catch (err) {
      log.debug({ error: err, clue: result.clueRevealed }, 'Failed to add clue (may already exist)');
    }
  }

  // Log game event
  if (result.secretFound) {
    await addGameEvent(
      game,
      'game_secret',
      `Secret found in mini-game: ${result.secretFound.substring(0, 80)}`,
      {
        secret: result.secretFound,
        clue: result.clueRevealed,
      },
      7,
    );
  }

  // Send notification
  if (result.clueRevealed) {
    await createNotification(
      game.userId,
      'clue',
      `New clue discovered: ${result.clueRevealed}`,
    );
  }
}

// Re-export game functions for direct use
export { matrixRain } from './matrix-rain.js';
export { numberStation } from './number-station.js';
export { memorySequence } from './memory-sequence.js';
export { hackFirewall } from './firewall.js';
export { wormGame } from './worm.js';
