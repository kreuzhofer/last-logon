// Game Initialization — first-time setup when a player starts Last Logon
// Handles language selection and initial game state creation

import { Color, setColor, resetColor } from '../terminal/ansi.js';
import { getConfig } from '../core/config.js';
import { createChildLogger } from '../core/logger.js';
import { createPlayerGame, addGameEvent, addStoryLogEntry } from './game-layer.js';
import { injectGhostOneLiners } from './message-bridge.js';
import { connectionEffect, displayScriptedText, sleep } from './narrative.js';
import { getChapter } from './base-script-loader.js';
import type { Terminal } from '../terminal/terminal.js';
import type { ScreenFrame, HotkeyDef } from '../terminal/screen-frame.js';
import type { Session } from '../auth/session.js';
import type { PlayerGame } from '@prisma/client';

const log = createChildLogger('game-init');

const HOTKEYS_INIT: HotkeyDef[] = [
  { key: 'E', label: 'English' },
  { key: 'D', label: 'Deutsch' },
];

export async function initializeNewGame(
  session: Session,
  frame: ScreenFrame,
): Promise<PlayerGame | null> {
  const terminal = session.terminal;
  const config = getConfig();
  const userId = session.user!.id;

  // Language selection
  frame.refresh([config.general.bbsName, 'Last Logon', 'Setup'], HOTKEYS_INIT);
  frame.skipLine();

  frame.writeContentLine(setColor(Color.DarkGray) + '░░░ LAST LOGON ░░░' + resetColor());
  frame.skipLine();
  frame.writeContentLine(setColor(Color.LightCyan) + 'Select your language / Wähle deine Sprache:' + resetColor());
  frame.skipLine();
  frame.writeContentLine(
    setColor(Color.DarkCyan) + '[' + setColor(Color.White) + 'E' +
    setColor(Color.DarkCyan) + '] ' + setColor(Color.LightGray) + 'English',
  );
  frame.writeContentLine(
    setColor(Color.DarkCyan) + '[' + setColor(Color.White) + 'D' +
    setColor(Color.DarkCyan) + '] ' + setColor(Color.LightGray) + 'Deutsch',
  );
  frame.skipLine();

  terminal.moveTo(frame.currentRow, frame.contentLeft);
  terminal.write(setColor(Color.LightCyan) + '> ' + setColor(Color.White));
  const langChoice = await terminal.readHotkey(['E', 'D']);
  const language = langChoice === 'D' ? 'de' : 'en';

  // Create game state
  const game = await createPlayerGame(userId, language);

  // Log the initialization
  await addGameEvent(game, 'game_start', `New game started, language: ${language}`, { language }, 10);
  await addStoryLogEntry(game, 'login', 'Game initialized');

  // Inject ghost one-liners into the BBS
  await injectGhostOneLiners(game);

  // Show connection effect
  frame.refresh([config.general.bbsName, 'Last Logon'], [{ key: 'Q', label: 'Continue' }]);
  frame.skipLine();
  await connectionEffect(terminal, frame, language);

  // Show the prologue scripted text
  const prologue = getChapter('prologue');
  const firstBeat = prologue?.beats.find(b => b.tag === 'first_login');
  if (firstBeat?.scriptedText) {
    await sleep(500);
    displayScriptedText(frame, firstBeat.scriptedText, language, firstBeat.scriptedTextDe);
  }

  frame.skipLine();
  terminal.moveTo(frame.currentRow, frame.contentLeft);
  await terminal.pause();

  log.info({ userId, language }, 'New game initialized');
  return game;
}
