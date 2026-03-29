// Last Logon — Main game entry point (Door Game module)
// Follows BBS module pattern: async function(session, frame): Promise<void>

import { Color, setColor, resetColor } from '../terminal/ansi.js';
import { parsePipeCodes } from '../utils/pipe-codes.js';
import { padRight, center, formatDateTime } from '../utils/string-utils.js';
import { getConfig } from '../core/config.js';
import { createChildLogger } from '../core/logger.js';
import {
  getPlayerGame,
  buildStoryContext,
  getUnlockedFeatures,
  isFeatureUnlocked,
  getPendingNotifications,
  markNotificationsRead,
  onPlayerLogin,
  getTriggeredBeats,
  completeBeat,
  addClue,
  unlockFeatures,
  addStoryLogEntry,
  addGameEvent,
  checkChapterProgression,
  applyKillerResponseEffects,
  updatePlayerGame,
} from './game-layer.js';
import { initializeNewGame } from './game-init.js';
import {
  displayText,
  displayScriptedText,
  displayChatMessage,
  displaySystemMessage,
  showTypingIndicator,
  connectionEffect,
  displayClueEntry,
  sleep,
} from './narrative.js';
import { getKillerResponse } from './ai-engine.js';
import { runPuzzle } from './puzzles/puzzle-engine.js';
import { runHiddenTerminal } from './hidden-terminal.js';
import { getGameMessages, getUnreadGameMessageCount, checkAndSendNPCMessages } from './message-bridge.js';
import { getChapter, getChapterBeats, getBeat, getClueDef, getPuzzleDef } from './base-script-loader.js';
import type { Terminal } from '../terminal/terminal.js';
import type { ScreenFrame, HotkeyDef } from '../terminal/screen-frame.js';
import type { Session } from '../auth/session.js';
import type { PlayerGame } from '@prisma/client';
import type { ChapterTag, StoryContext, StoryBeat } from './game-types.js';

const log = createChildLogger('last-logon');

// ─── Hotkey definitions ──────────────────────────────────────────────────────

function getMainHotkeys(game: PlayerGame, lang: string): HotkeyDef[] {
  const keys: HotkeyDef[] = [
    { key: 'T', label: 'Terminal' },
  ];
  if (isFeatureUnlocked(game, 'messages') || isFeatureUnlocked(game, 'gameMessages')) {
    keys.push({ key: 'M', label: lang === 'de' ? 'Nachrichten' : 'Messages' });
  }
  if (isFeatureUnlocked(game, 'hiddenTerminal')) {
    keys.push({ key: 'F', label: lang === 'de' ? 'Dateien' : 'Files' });
  }
  keys.push({ key: 'J', label: 'Journal' });
  keys.push({ key: 'Q', label: lang === 'de' ? 'Trennen' : 'Disconnect' });
  return keys;
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

export async function lastLogonDoor(session: Session, frame: ScreenFrame): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();
  const userId = session.user!.id;
  const playerHandle = session.handle;

  // Load or initialize game
  let game = await getPlayerGame(userId);

  if (!game) {
    // New game
    game = await initializeNewGame(session, frame);
    if (!game) return;
  } else {
    // Returning player
    game = await onPlayerLogin(userId);
    if (!game) return;

    // Show connection effect
    frame.refresh([config.general.bbsName, 'Last Logon'], [{ key: 'Q', label: 'Continue' }]);
    frame.skipLine();
    await connectionEffect(terminal, frame, game.language);

    // Check for notifications
    const notifications = await getPendingNotifications(userId);
    if (notifications.length > 0) {
      const label = game.language === 'de' ? 'Neue Benachrichtigungen' : 'New notifications';
      frame.writeContentLine(setColor(Color.Yellow) + `═══ ${label} ═══` + resetColor());
      frame.skipLine();
      for (const notif of notifications.slice(0, 5)) {
        frame.writeContentLine(
          setColor(Color.DarkGray) + '► ' +
          setColor(Color.LightGray) + notif.content + resetColor(),
        );
      }
      await markNotificationsRead(userId);
      frame.skipLine();
    }

    // Check and send NPC messages based on triggers
    const context = await buildStoryContext(game);
    await checkAndSendNPCMessages(game, playerHandle, context);

    // Process auto-triggered beats
    await processAutoBeats(game, session, frame);

    terminal.moveTo(frame.currentRow, frame.contentLeft);
    await terminal.pause();
  }

  // Main game menu loop
  await gameMenuLoop(session, frame, game);
}

// ─── Game Menu Loop ──────────────────────────────────────────────────────────

async function gameMenuLoop(session: Session, frame: ScreenFrame, initialGame: PlayerGame): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();
  let game = initialGame;

  while (true) {
    // Reload game state
    const refreshed = await getPlayerGame(game.userId);
    if (refreshed) game = refreshed;

    const context = await buildStoryContext(game);
    const hotkeys = getMainHotkeys(game, game.language);
    const availableKeys = hotkeys.map(h => h.key);

    frame.refresh([config.general.bbsName, 'Last Logon'], hotkeys);
    frame.skipLine();

    // Title
    const title = game.language === 'de' ? 'DAS UNTERGRUND-SYSTEM' : 'THE UNDERGROUND';
    frame.writeContentLine(setColor(Color.LightCyan) + center(title, frame.contentWidth) + resetColor());
    frame.skipLine();

    // Menu items
    for (const hk of hotkeys) {
      if (hk.key === 'Q') continue;
      frame.writeContentLine(
        '  ' + setColor(Color.DarkCyan) + '[' + setColor(Color.White) + hk.key +
        setColor(Color.DarkCyan) + '] ' + setColor(Color.LightGray) + hk.label + resetColor(),
      );
    }
    frame.writeContentLine(
      '  ' + setColor(Color.DarkCyan) + '[' + setColor(Color.White) + 'Q' +
      setColor(Color.DarkCyan) + '] ' + setColor(Color.DarkGray) +
      (game.language === 'de' ? 'Trennen' : 'Disconnect') + resetColor(),
    );

    frame.skipLine();

    // Status bar
    const chapterDef = getChapter(game.chapter as ChapterTag);
    const chapterTitle = (game.language === 'de' && chapterDef?.titleDe)
      ? chapterDef.titleDe : (chapterDef?.title ?? game.chapter);
    frame.writeContentLine(
      setColor(Color.DarkGray) + 'Chapter: ' + setColor(Color.LightCyan) + chapterTitle +
      setColor(Color.DarkGray) + '  │  Mood: ' + setColor(Color.LightCyan) + game.killerMood +
      resetColor(),
    );

    // Unread messages count
    const unread = await getUnreadGameMessageCount(userId(session), session.handle);
    if (unread > 0) {
      const unreadMsg = game.language === 'de'
        ? `${unread} ungelesene Nachricht(en)`
        : `${unread} unread message(s)`;
      frame.writeContentLine(
        setColor(Color.Yellow) + '► ' + unreadMsg + resetColor(),
      );
    }

    frame.skipLine();

    // Prompt
    terminal.moveTo(frame.currentRow, frame.contentLeft);
    terminal.write(setColor(Color.LightCyan) + '> ' + setColor(Color.White));
    const choice = await terminal.readHotkey(availableKeys);

    switch (choice) {
      case 'T':
        await terminalScreen(session, frame, game);
        break;
      case 'M':
        await messagesScreen(session, frame, game);
        break;
      case 'F':
        await runHiddenTerminal(session, frame, game, await buildStoryContext(game));
        break;
      case 'J':
        await journalScreen(session, frame, game);
        break;
      case 'Q':
        await addStoryLogEntry(game, 'login', 'Player disconnected from Last Logon');
        return;
    }

    // After each action, check chapter progression
    const advanced = await checkChapterProgression(game);
    if (advanced) {
      const updatedGame = await getPlayerGame(game.userId);
      if (updatedGame) {
        game = updatedGame;
        await showChapterTransition(session, frame, game);
      }
    }
  }
}

function userId(session: Session): number {
  return session.user!.id;
}

// ─── Terminal / Chat Screen ──────────────────────────────────────────────────

async function terminalScreen(session: Session, frame: ScreenFrame, game: PlayerGame): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();
  const context = await buildStoryContext(game);

  // Check for triggered beats that need to be shown
  const triggeredBeats = getTriggeredBeats(game, { type: 'player_action', value: 'enter_terminal' });
  for (const beat of triggeredBeats) {
    await processBeat(beat, game, session, frame, context);
  }

  // Chat loop
  while (true) {
    frame.refresh([config.general.bbsName, 'Last Logon', 'Terminal'], [
      { key: 'P', label: 'Puzzle' },
      { key: 'Q', label: 'Back' },
    ]);
    frame.skipLine();

    const label = game.language === 'de' ? 'TERMINAL — Direktverbindung' : 'TERMINAL — Direct Connection';
    frame.writeContentLine(setColor(Color.DarkGray) + label + resetColor());
    frame.writeContentLine(
      setColor(Color.DarkGray) + (game.language === 'de'
        ? 'Schreibe eine Nachricht oder "quit" zum Verlassen.'
        : 'Type a message or "quit" to leave.') + resetColor(),
    );
    frame.skipLine();

    // Show recent conversation
    const db = (await import('../core/database.js')).getDb();
    const recentMessages = await db.gameConversation.findMany({
      where: { userId: game.userId },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    for (const msg of recentMessages.reverse()) {
      if (msg.role === 'user') {
        displayChatMessage(frame, session.handle, msg.content, Color.LightGreen);
      } else {
        displayChatMessage(frame, game.killerAlias, msg.content, Color.LightRed);
      }
    }

    frame.skipLine();

    // Input
    terminal.moveTo(frame.currentRow, frame.contentLeft);
    terminal.write(setColor(Color.LightGreen) + session.handle + setColor(Color.DarkGray) + ': ' + setColor(Color.White));
    const input = await terminal.readLine({ maxLength: 200 });

    if (!input || input.toLowerCase() === 'quit' || input.toLowerCase() === 'q') {
      return;
    }

    // Check for puzzle command
    if (input.toLowerCase() === 'p' || input.toLowerCase() === 'puzzle') {
      await puzzleMenu(session, frame, game);
      continue;
    }

    // Show typing indicator and get AI response
    frame.skipLine();
    await showTypingIndicator(terminal, frame, game.killerAlias, 1500);

    const updatedContext = await buildStoryContext(game);
    const response = await getKillerResponse(game.userId, input, updatedContext);

    // Display response
    displayChatMessage(frame, game.killerAlias, response.text, Color.LightRed);

    // Apply effects
    await applyKillerResponseEffects(game, response);

    // Reload game state
    const refreshed = await getPlayerGame(game.userId);
    if (refreshed) game = refreshed;

    frame.skipLine();
    terminal.moveTo(frame.currentRow, frame.contentLeft);
    await terminal.pause();
  }
}

// ─── Messages Screen ─────────────────────────────────────────────────────────

async function messagesScreen(session: Session, frame: ScreenFrame, game: PlayerGame): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();

  while (true) {
    frame.refresh([config.general.bbsName, 'Last Logon', game.language === 'de' ? 'Nachrichten' : 'Messages'], [
      { key: 'N', label: 'Next' },
      { key: 'Q', label: 'Back' },
    ]);
    frame.skipLine();

    const messages = await getGameMessages(game.userId, session.handle, 15);

    if (messages.length === 0) {
      const noMsg = game.language === 'de' ? 'Keine Nachrichten.' : 'No messages.';
      frame.writeContentLine(setColor(Color.DarkGray) + noMsg + resetColor());
    } else {
      for (const msg of messages.reverse()) {
        if (frame.remainingRows <= 3) break;

        const dateStr = formatDateTime(msg.createdAt);
        const fromColor = msg.from === game.killerAlias ? Color.LightRed : Color.LightCyan;

        frame.writeContentLine(
          setColor(Color.DarkGray) + '─────────────────────────────────────────' + resetColor(),
        );
        frame.writeContentLine(
          setColor(Color.DarkGray) + 'From: ' + setColor(fromColor) + msg.from +
          setColor(Color.DarkGray) + '  │  ' + dateStr + resetColor(),
        );
        frame.writeContentLine(
          setColor(Color.DarkGray) + 'Subj: ' + setColor(Color.White) + msg.subject + resetColor(),
        );

        // Show first 2 lines of body
        const bodyLines = msg.body.split('\n').filter(l => l.trim()).slice(0, 2);
        for (const line of bodyLines) {
          if (frame.remainingRows <= 2) break;
          frame.writeContentLine(setColor(Color.LightGray) + '  ' + line.trim().substring(0, 72) + resetColor());
        }
      }
    }

    // Mark as read
    const db = (await import('../core/database.js')).getDb();
    const area = await db.messageArea.findUnique({ where: { tag: 'lastlogon.private' } });
    if (area && messages.length > 0) {
      const lastMsgId = Math.max(...messages.map(m => m.id));
      await db.messageRead.upsert({
        where: { userId_areaId: { userId: game.userId, areaId: area.id } },
        create: { userId: game.userId, areaId: area.id, lastReadId: lastMsgId },
        update: { lastReadId: lastMsgId },
      });
    }

    frame.skipLine();
    terminal.moveTo(frame.currentRow, frame.contentLeft);
    const choice = await terminal.readHotkey(['N', 'Q']);
    if (choice === 'Q') return;
  }
}

// ─── Journal Screen ──────────────────────────────────────────────────────────

async function journalScreen(session: Session, frame: ScreenFrame, game: PlayerGame): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();
  const context = await buildStoryContext(game);

  frame.refresh([config.general.bbsName, 'Last Logon', 'Journal'], [{ key: 'Q', label: 'Back' }]);
  frame.skipLine();

  const title = game.language === 'de' ? 'ERMITTLUNGSJOURNAL' : 'INVESTIGATION JOURNAL';
  frame.writeContentLine(setColor(Color.LightCyan) + center(title, frame.contentWidth) + resetColor());
  frame.skipLine();

  // Clues found
  const cluesLabel = game.language === 'de' ? 'Gefundene Hinweise:' : 'Clues Found:';
  frame.writeContentLine(setColor(Color.Yellow) + cluesLabel + resetColor());

  const clues = context.cluesFound;
  if (clues.length === 0) {
    const noneMsg = game.language === 'de' ? '  (noch keine)' : '  (none yet)';
    frame.writeContentLine(setColor(Color.DarkGray) + noneMsg + resetColor());
  } else {
    for (let i = 0; i < clues.length; i++) {
      if (frame.remainingRows <= 5) break;
      const clueDef = getClueDef(clues[i]!);
      const desc = (game.language === 'de' && clueDef?.descriptionDe)
        ? clueDef.descriptionDe : (clueDef?.description ?? clues[i]!);
      displayClueEntry(frame, i + 1, clues[i]!, desc, clueDef?.evidenceWeight ?? 1);
    }
  }

  frame.skipLine();

  // Puzzles solved
  const puzzlesLabel = game.language === 'de' ? 'Gelöste Rätsel:' : 'Puzzles Solved:';
  frame.writeContentLine(setColor(Color.Yellow) + puzzlesLabel + resetColor());

  const puzzles = context.puzzlesSolved;
  if (puzzles.length === 0) {
    const noneMsg = game.language === 'de' ? '  (noch keine)' : '  (none yet)';
    frame.writeContentLine(setColor(Color.DarkGray) + noneMsg + resetColor());
  } else {
    for (const p of puzzles) {
      if (frame.remainingRows <= 3) break;
      frame.writeContentLine(
        setColor(Color.LightGreen) + '  ✓ ' + setColor(Color.LightGray) + p + resetColor(),
      );
    }
  }

  frame.skipLine();
  terminal.moveTo(frame.currentRow, frame.contentLeft);
  await terminal.pause();
}

// ─── Puzzle Menu ─────────────────────────────────────────────────────────────

async function puzzleMenu(session: Session, frame: ScreenFrame, game: PlayerGame): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();
  const context = await buildStoryContext(game);
  const chapterBeats = getChapterBeats(game.chapter as ChapterTag);

  // Find available puzzles in current chapter
  const puzzleBeats = chapterBeats.filter(b => b.puzzle && !context.puzzlesSolved.includes(b.puzzle));

  if (puzzleBeats.length === 0) {
    frame.refresh([config.general.bbsName, 'Last Logon', 'Puzzles'], [{ key: 'Q', label: 'Back' }]);
    frame.skipLine();
    const noMsg = game.language === 'de'
      ? 'Keine aktiven Rätsel im Moment.'
      : 'No active puzzles at the moment.';
    frame.writeContentLine(setColor(Color.DarkGray) + noMsg + resetColor());
    frame.skipLine();
    terminal.moveTo(frame.currentRow, frame.contentLeft);
    await terminal.pause();
    return;
  }

  // Show puzzle list and let player choose
  const hotkeys: HotkeyDef[] = [];
  const puzzleMap = new Map<string, string>();

  frame.refresh([config.general.bbsName, 'Last Logon', 'Puzzles'], [{ key: 'Q', label: 'Back' }]);
  frame.skipLine();

  for (let i = 0; i < puzzleBeats.length && i < 9; i++) {
    const beat = puzzleBeats[i]!;
    const key = String(i + 1);
    const puzzleDef = getPuzzleDef(beat.puzzle!);
    const label = puzzleDef?.tag ?? beat.puzzle!;
    hotkeys.push({ key, label });
    puzzleMap.set(key, beat.puzzle!);

    frame.writeContentLine(
      '  ' + setColor(Color.DarkCyan) + '[' + setColor(Color.White) + key +
      setColor(Color.DarkCyan) + '] ' + setColor(Color.LightGray) + label +
      setColor(Color.DarkGray) + ` (${puzzleDef?.difficulty ?? '?'})` + resetColor(),
    );
  }

  frame.skipLine();
  terminal.moveTo(frame.currentRow, frame.contentLeft);
  terminal.write(setColor(Color.LightCyan) + '> ' + setColor(Color.White));
  const choice = await terminal.readHotkey([...puzzleMap.keys(), 'Q']);

  if (choice === 'Q') return;

  const puzzleTag = puzzleMap.get(choice);
  if (puzzleTag) {
    const solved = await runPuzzle(session, frame, puzzleTag, game, context);
    if (solved) {
      // Find and complete the beat
      const beat = chapterBeats.find(b => b.puzzle === puzzleTag);
      if (beat) {
        await completeBeat(game, beat.tag);
      }
    }
  }
}

// ─── Beat Processing ─────────────────────────────────────────────────────────

async function processAutoBeats(game: PlayerGame, session: Session, frame: ScreenFrame): Promise<void> {
  const context = await buildStoryContext(game);
  const triggeredBeats = getTriggeredBeats(game);

  for (const beat of triggeredBeats) {
    await processBeat(beat, game, session, frame, context);
  }
}

async function processBeat(
  beat: StoryBeat,
  game: PlayerGame,
  session: Session,
  frame: ScreenFrame,
  context: StoryContext,
): Promise<void> {
  const config = getConfig();

  // Show scripted text if available
  if (beat.scriptedText) {
    frame.refresh([config.general.bbsName, 'Last Logon'], [{ key: 'Q', label: 'Continue' }]);
    frame.skipLine();
    displayScriptedText(frame, beat.scriptedText, game.language, beat.scriptedTextDe);
    frame.skipLine();
    session.terminal.moveTo(frame.currentRow, frame.contentLeft);
    await session.terminal.pause();
  }

  // Apply beat effects
  if (beat.clue) {
    await addClue(game, beat.clue);
  }
  if (beat.unlocks?.length) {
    await unlockFeatures(game, beat.unlocks);
  }
  if (beat.killerMood) {
    await updatePlayerGame(game.id, { killerMood: beat.killerMood });
  }

  // Complete the beat
  await completeBeat(game, beat.tag);

  log.info({ gameId: game.id, beat: beat.tag }, 'Beat processed');
}

// ─── Chapter Transition ──────────────────────────────────────────────────────

async function showChapterTransition(session: Session, frame: ScreenFrame, game: PlayerGame): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();
  const chapterDef = getChapter(game.chapter as ChapterTag);

  frame.refresh([config.general.bbsName, 'Last Logon'], [{ key: 'Q', label: 'Continue' }]);
  frame.skipLine();
  frame.skipLine();

  frame.writeContentLine(setColor(Color.DarkGray) + '░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░' + resetColor());
  frame.skipLine();

  const title = (game.language === 'de' && chapterDef?.titleDe)
    ? chapterDef.titleDe : (chapterDef?.title ?? game.chapter);
  frame.writeContentLine(setColor(Color.White) + center(title, frame.contentWidth) + resetColor());

  const desc = (game.language === 'de' && chapterDef?.descriptionDe)
    ? chapterDef.descriptionDe : (chapterDef?.description ?? '');
  frame.skipLine();
  frame.writeContentLine(setColor(Color.DarkGray) + center(desc, frame.contentWidth) + resetColor());

  frame.skipLine();
  frame.writeContentLine(setColor(Color.DarkGray) + '░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░' + resetColor());
  frame.skipLine();

  terminal.moveTo(frame.currentRow, frame.contentLeft);
  await terminal.pause();

  // Process auto-beats for the new chapter
  await processAutoBeats(game, session, frame);
}
