// Last Logon — Game screen modules callable from the BBS main loop
// Each screen follows the pattern: async function(session, frame, game): Promise<void>

import { Color, setColor, resetColor } from '../terminal/ansi.js';
import { center, formatDateTime } from '../utils/string-utils.js';
import { getConfig } from '../core/config.js';
import { createChildLogger } from '../core/logger.js';
import {
  getPlayerGame,
  buildStoryContext,
  getTriggeredBeats,
  completeBeat,
  addClue,
  unlockFeatures,
  addStoryLogEntry,
  checkChapterProgression,
  applyKillerResponseEffects,
  updatePlayerGame,
} from './game-layer.js';
import {
  displayScriptedText,
  displayChatMessage,
  showTypingIndicator,
  displayClueEntry,
} from './narrative.js';
import { sendMail } from '../messages/message-service.js';
import { parsePipeCodes } from '../utils/pipe-codes.js';
import { stripPipeCodes } from '../utils/pipe-codes.js';
import { getKillerResponse } from './ai-engine.js';
import { runPuzzle } from './puzzles/puzzle-engine.js';
import { getChapter, getChapterBeats, getClueDef, getPuzzleDef } from './base-script-loader.js';
import type { ScreenFrame, HotkeyDef } from '../terminal/screen-frame.js';
import type { Session } from '../auth/session.js';
import type { PlayerGame } from '@prisma/client';
import type { ChapterTag, StoryContext, StoryBeat } from './game-types.js';

const log = createChildLogger('last-logon');

// ─── Terminal / Chat Screen ──────────────────────────────────────────────────

export async function terminalScreen(session: Session, frame: ScreenFrame, game: PlayerGame): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();
  const context = await buildStoryContext(game);

  // Check for triggered beats that need to be shown
  const triggeredBeats = getTriggeredBeats(game, { type: 'player_action', value: 'enter_terminal' });
  for (const beat of triggeredBeats) {
    await processBeat(beat, game, session, frame, context);
  }

  const drawChatScreen = async () => {
    const db = (await import('../core/database.js')).getDb();

    frame.refresh([config.general.bbsName, 'Chat'], [
      { key: 'Q', label: 'Back' },
    ]);

    frame.writeContentLine(
      setColor(Color.DarkGray) + (game.language === 'de'
        ? 'Chat mit ' + setColor(Color.LightRed) + game.killerAlias + setColor(Color.DarkGray) + ' — "quit" zum Verlassen'
        : 'Chat with ' + setColor(Color.LightRed) + game.killerAlias + setColor(Color.DarkGray) + ' — type "quit" to leave') + resetColor(),
    );
    frame.writeContentLine(setColor(Color.DarkGray) + '─'.repeat(frame.contentWidth) + resetColor());

    // Show conversation history — fill available space
    const availableRows = frame.remainingRows - 3; // reserve for separator + input + padding
    const recentMessages = await db.gameConversation.findMany({
      where: { userId: game.userId },
      orderBy: { createdAt: 'desc' },
      take: Math.max(3, Math.floor(availableRows / 2)),
    });

    for (const msg of recentMessages.reverse()) {
      if (frame.remainingRows <= 4) break;
      if (msg.role === 'user') {
        displayChatMessage(frame, session.handle, msg.content, Color.LightGreen);
      } else {
        displayChatMessage(frame, game.killerAlias, msg.content, Color.LightRed);
      }
    }

    frame.writeContentLine(setColor(Color.DarkGray) + '─'.repeat(frame.contentWidth) + resetColor());
  };

  // Initial draw
  await drawChatScreen();

  // Chat loop
  while (true) {
    // Input prompt
    terminal.moveTo(frame.currentRow, frame.contentLeft);
    terminal.write(setColor(Color.LightGreen) + session.handle + setColor(Color.DarkGray) + ': ' + setColor(Color.White));
    const input = await terminal.readLine({ maxLength: 200 });

    if (!input || input.toLowerCase() === 'quit' || input.toLowerCase() === 'q') {
      return;
    }

    if (input.toLowerCase() === 'p' || input.toLowerCase() === 'puzzle') {
      await puzzleMenu(session, frame, game);
      await drawChatScreen();
      continue;
    }

    // Show typing indicator
    if (frame.remainingRows > 1) {
      terminal.moveTo(frame.currentRow, frame.contentLeft);
      terminal.write(setColor(Color.DarkGray) + game.killerAlias + ' is typing...' + resetColor());
    }

    const updatedContext = await buildStoryContext(game);
    const response = await getKillerResponse(game.userId, input, updatedContext);

    // Apply effects
    await applyKillerResponseEffects(game, response);

    // Reload game state
    const refreshed = await getPlayerGame(game.userId);
    if (refreshed) game = refreshed;

    // Redraw the full chat with updated conversation
    await drawChatScreen();
  }
}

// ─── Journal Screen ──────────────────────────────────────────────────────────

export async function journalScreen(session: Session, frame: ScreenFrame, game: PlayerGame): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();
  const context = await buildStoryContext(game);

  frame.refresh([config.general.bbsName, 'Journal'], [{ key: 'Q', label: 'Back' }]);
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

export async function puzzleMenu(session: Session, frame: ScreenFrame, game: PlayerGame): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();
  const context = await buildStoryContext(game);
  const chapterBeats = getChapterBeats(game.chapter as ChapterTag);

  // Find available puzzles in current chapter
  const puzzleBeats = chapterBeats.filter(b => b.puzzle && !context.puzzlesSolved.includes(b.puzzle));

  if (puzzleBeats.length === 0) {
    frame.refresh([config.general.bbsName, 'Puzzles'], [{ key: 'Q', label: 'Back' }]);
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
  const puzzleMap = new Map<string, string>();

  frame.refresh([config.general.bbsName, 'Puzzles'], [{ key: 'Q', label: 'Back' }]);
  frame.skipLine();

  for (let i = 0; i < puzzleBeats.length && i < 9; i++) {
    const beat = puzzleBeats[i]!;
    const key = String(i + 1);
    const puzzleDef = getPuzzleDef(beat.puzzle!);
    const label = puzzleDef?.tag ?? beat.puzzle!;
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
      const beat = chapterBeats.find(b => b.puzzle === puzzleTag);
      if (beat) {
        await completeBeat(game, beat.tag);
      }
    }
  }
}

// ─── Beat Processing ─────────────────────────────────────────────────────────

export async function processAutoBeats(game: PlayerGame, session: Session, frame: ScreenFrame): Promise<void> {
  const context = await buildStoryContext(game);
  const triggeredBeats = getTriggeredBeats(game);

  for (const beat of triggeredBeats) {
    await processBeat(beat, game, session, frame, context);
  }
}

export async function processBeat(
  beat: StoryBeat,
  game: PlayerGame,
  session: Session,
  frame: ScreenFrame,
  context: StoryContext,
): Promise<void> {
  const config = getConfig();

  // Deliver scripted text — major story moments as full-screen, everything else as mail
  if (beat.scriptedText) {
    const text = (game.language === 'de' && beat.scriptedTextDe) ? beat.scriptedTextDe : beat.scriptedText;
    const plainText = stripPipeCodes(text).trim();

    // These beats are dramatic moments that deserve full-screen display
    const fullScreenBeats = ['first_login', 'confrontation', 'resolution', 'escape'];

    if (fullScreenBeats.includes(beat.tag)) {
      frame.refresh([config.general.bbsName], [{ key: 'Q', label: 'Continue' }]);
      frame.skipLine();
      displayScriptedText(frame, beat.scriptedText, game.language, beat.scriptedTextDe);
      frame.skipLine();
      session.terminal.moveTo(frame.currentRow, frame.contentLeft);
      await session.terminal.pause();
    } else {
      // Deliver as personal mail — in-character subjects, not meta descriptions
      const senderMap: Record<string, string> = {
        'strange_bulletin': 'SYSTEM',
        'killer_first_contact': game.killerAlias,
        'killer_escalation': game.killerAlias,
        'npc_threatened': 'D_COLE',
        'npc_in_danger': 'SIGNAL_LOST',
      };
      const subjectMap: Record<string, string> = {
        'strange_bulletin': 'News Alert: Missing Persons Update',
        'killer_first_contact': 'I noticed you',
        'killer_escalation': 'We need to talk.',
        'npc_threatened': 'Something is wrong — be careful',
        'npc_in_danger': 'I think someone is watching me',
        'last_callers_pattern': 'System Notice: Caller Log Archive',
        'worried_user_contact': 'Hey, can we talk?',
      };
      const sender = senderMap[beat.tag] ?? 'SYSTEM';
      const subject = subjectMap[beat.tag] ?? beat.tag;

      await sendMail(game.id, null, sender, session.handle, subject, plainText);

      // Update the mail indicator
      frame.hasNewMail = true;
    }
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

export async function showChapterTransition(session: Session, frame: ScreenFrame, game: PlayerGame): Promise<void> {
  const chapterDef = getChapter(game.chapter as ChapterTag);

  // In-character mail from AXIOM about expanded access
  const chapterMailSubjects: Record<string, string> = {
    'chapter1': "Your access has been updated",
    'chapter2': "I've expanded your privileges",
    'chapter3': "You've earned deeper access",
    'chapter4': "Full system access granted",
    'chapter5_caught': "It's over",
    'chapter5_escaped': "Goodbye",
  };

  const chapterMailBodies: Record<string, string> = {
    'chapter1':
      "I've noticed you spending time on the board.\n\n" +
      "I like that. Most people just pass through.\n\n" +
      "I've opened up a few more areas for you. Bulletins, caller logs.\n" +
      "Take a look around. There's more here than meets the eye.\n\n" +
      "— The SysOp",
    'chapter2':
      "You've been paying attention. Good.\n\n" +
      "Most users never look past the surface. You're different.\n\n" +
      "I've given you access to some... additional tools.\n" +
      "Terminal access. The file system. Some games.\n\n" +
      "Use them wisely. Or don't. I'll be watching either way.\n\n" +
      "— AXIOM",
    'chapter3':
      "You're getting closer to something.\n\n" +
      "I can tell by the way you navigate. The files you read.\n" +
      "The questions you ask.\n\n" +
      "Full access. Everything is open to you now.\n" +
      "But be careful what you dig up. Some things are buried for a reason.\n\n" +
      "— AXIOM",
    'chapter4':
      "No more walls. No more locked doors.\n\n" +
      "You have everything you need now.\n" +
      "The question is: what will you do with it?\n\n" +
      "— AXIOM",
  };

  const subject = chapterMailSubjects[game.chapter] ?? 'System Update';
  const body = chapterMailBodies[game.chapter] ??
    `Your access level has been updated.\n\nNew features are now available in the main menu.\n\n— The SysOp`;

  await sendMail(game.id, null, game.killerAlias, session.handle, subject, body);
  frame.hasNewMail = true;

  // Process auto-beats for the new chapter
  await processAutoBeats(game, session, frame);
}
