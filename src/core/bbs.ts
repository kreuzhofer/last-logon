// BBS orchestration - the main session handler
// Each SSH connection gets a session that flows through: welcome -> login -> main menu
// ALL screens use ScreenFrame for consistent border, breadcrumb, and hotkey bar

import { Color, setColor, resetColor, BoxChars } from '../terminal/ansi.js';
import { Terminal } from '../terminal/terminal.js';
import { ScreenFrame, type HotkeyDef } from '../terminal/screen-frame.js';
import { Session } from '../auth/session.js';
import * as auth from '../auth/auth-service.js';
import { getConfig } from './config.js';
import { createChildLogger } from './logger.js';
import { getDb } from './database.js';
import { eventBus } from './events.js';
import type { SSHConnection } from '../server/connection.js';
import * as messageService from '../messages/message-service.js';
import { padRight, center, formatDate, formatDateTime, truncate, wordWrap, formatNumber, stripAnsi } from '../utils/string-utils.js';
import { parsePipeCodes, stripPipeCodes } from '../utils/pipe-codes.js';
import { terminalScreen, journalScreen, processAutoBeats, showChapterTransition } from '../game/index.js';
import {
  getPlayerGame,
  createPlayerGame,
  onPlayerLogin as gameOnLogin,
  onPlayerLogout as gameOnLogout,
  isFeatureUnlocked,
  getPendingNotifications,
  markNotificationsRead,
  buildStoryContext,
  getTriggeredBeats,
  checkChapterProgression,
  addGameEvent,
  addStoryLogEntry,
} from '../game/game-layer.js';
import { processBeat } from '../game/screens.js';
import { injectGhostOneLiners, checkAndSendNPCMessages } from '../game/message-bridge.js';
import { seedPlayerContent } from '../game/content-seeder.js';
import { connectionEffect, displayScriptedText, sleep } from '../game/narrative.js';
import { runHiddenTerminal } from '../game/hidden-terminal.js';
import { gamesMenu } from '../games/index.js';
import { getChapter } from '../game/base-script-loader.js';
import type { PlayerGame } from '@prisma/client';
import type { ChapterTag } from '../game/game-types.js';

const log = createChildLogger('bbs');

// Shorthand color helpers
function c(fg: Color, text: string): string {
  return setColor(fg) + text;
}
function cr(): string {
  return resetColor();
}

// ─── Reusable Lightbar List ─────────────────────────────────────────────────
// Renders a scrollable list with arrow key navigation and highlighted selection.

interface LightbarItem {
  text: string;           // Normal rendering (with ANSI colors)
  plainText: string;      // Plain text for highlight row (no ANSI — rendered with reverse colors)
}

interface LightbarResult {
  action: string;         // The hotkey pressed (e.g., 'ENTER', 'Q', 'W', etc.)
  index: number;          // Selected index when action was taken
}

async function lightbarList(
  terminal: Terminal,
  frame: ScreenFrame,
  items: LightbarItem[],
  startIndex: number,
  extraKeys: string[],    // Additional hotkeys beyond UP/DOWN/PGUP/PGDN/ENTER
  listRows: number,       // How many rows available for the list
): Promise<LightbarResult> {
  let selectedIndex = startIndex;
  let pageStart = 0;

  // Ensure bounds
  if (selectedIndex >= items.length) selectedIndex = Math.max(0, items.length - 1);
  if (selectedIndex < pageStart) pageStart = selectedIndex;
  if (selectedIndex >= pageStart + listRows) pageStart = selectedIndex - listRows + 1;

  const allKeys = ['UP', 'DOWN', 'PAGEUP', 'PAGEDOWN', 'ENTER', ...extraKeys];

  while (true) {
    // Adjust page window
    if (selectedIndex < pageStart) pageStart = selectedIndex;
    if (selectedIndex >= pageStart + listRows) pageStart = selectedIndex - listRows + 1;

    const pageEnd = Math.min(pageStart + listRows, items.length);
    const listStartRow = frame.currentRow;

    // Render visible items — every row must fill full width to clear previous highlights
    for (let i = pageStart; i < pageEnd; i++) {
      const item = items[i]!;
      if (i === selectedIndex) {
        frame.writeContentLine(
          setColor(Color.White, Color.DarkCyan) +
          padRight(item.plainText, frame.contentWidth) +
          resetColor(),
        );
      } else {
        // Pad with reset + spaces to clear any leftover background color
        frame.writeContent(resetColor() + item.text);
        terminal.clearToEndOfLine();
        frame.skipLine();
      }
    }

    // Clear remaining rows in the list area
    const rendered = pageEnd - pageStart;
    for (let i = rendered; i < listRows; i++) {
      frame.writeContent(resetColor());
      terminal.clearToEndOfLine();
      frame.skipLine();
    }

    // Page indicator
    const totalPages = Math.ceil(items.length / listRows);
    if (totalPages > 1) {
      const currentPage = Math.floor(pageStart / listRows) + 1;
      frame.writeContentLine(c(Color.DarkGray, ` Page ${currentPage}/${totalPages}`));
    }

    // Wait for input
    const key = await terminal.readHotkey(allKeys);

    switch (key) {
      case 'UP':
        if (selectedIndex > 0) selectedIndex--;
        break;
      case 'DOWN':
        if (selectedIndex < items.length - 1) selectedIndex++;
        break;
      case 'PAGEUP':
        selectedIndex = Math.max(0, selectedIndex - listRows);
        break;
      case 'PAGEDOWN':
        selectedIndex = Math.min(items.length - 1, selectedIndex + listRows);
        break;
      default:
        return { action: key, index: selectedIndex };
    }

    // Redraw: move cursor back to list start and re-render
    frame.setContentRow(listStartRow - frame.contentTop);
  }
}

// Common hotkey sets
const HOTKEYS_MATRIX: HotkeyDef[] = [
  { key: 'L', label: 'Login' },
  { key: 'N', label: 'New User' },
  { key: 'Q', label: 'Quit' },
];

// Dynamic menu items gated by game feature unlocking
interface MenuItem { key: string; label: string; feature?: string; }

const ALL_MENU_ITEMS: MenuItem[] = [
  { key: 'E', label: 'Mail' },
  { key: 'M', label: 'Messages', feature: 'messages' },
  { key: 'O', label: 'One-Liners', feature: 'oneliners' },
  { key: 'W', label: 'Who\'s Online', feature: 'whoIsOnline' },
  { key: 'U', label: 'User Profile', feature: 'userProfile' },
  { key: 'L', label: 'Last Callers', feature: 'lastCallers' },
  { key: 'B', label: 'Bulletins', feature: 'bulletins' },
  { key: 'V', label: 'Voting', feature: 'bulletins' },
  { key: 'D', label: 'Games', feature: 'doorGames' },
  { key: 'T', label: 'Terminal', feature: 'terminal' },
  { key: 'F', label: 'Files', feature: 'hiddenTerminal' },
  { key: 'J', label: 'Journal' },
  { key: 'S', label: 'Stats' },
  { key: 'G', label: 'Goodbye' },
];

function buildDynamicMenu(game: PlayerGame | null): { items: MenuItem[]; hotkeys: HotkeyDef[]; keys: string[] } {
  const visible = ALL_MENU_ITEMS.filter(item => {
    if (!item.feature) return true; // Always visible (Journal, Stats, Goodbye)
    if (!game) return false; // No game state = only show always-visible items
    return isFeatureUnlocked(game, item.feature);
  });
  return {
    items: visible,
    hotkeys: visible.map(i => ({ key: i.key, label: i.label })),
    keys: visible.map(i => i.key),
  };
}

const HOTKEYS_MESSAGES: HotkeyDef[] = [
  { key: 'R', label: 'Read' },
  { key: 'P', label: 'Post' },
  { key: 'S', label: 'Scan' },
  { key: 'C', label: 'Area' },
  { key: 'Q', label: 'Back' },
];

const HOTKEYS_READER: HotkeyDef[] = [
  { key: 'N', label: 'Next' },
  { key: 'P', label: 'Prev' },
  { key: 'R', label: 'Reply' },
  { key: 'Q', label: 'Back' },
];

const HOTKEYS_PAUSE: HotkeyDef[] = [
  { key: 'Q', label: 'Back' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Session Handler
// ─────────────────────────────────────────────────────────────────────────────

export async function handleSession(conn: SSHConnection): Promise<void> {
  const terminal = new Terminal(conn);
  const session = new Session(conn, terminal);
  const frame = new ScreenFrame(terminal);
  const config = getConfig();

  conn.onClose(() => {
    if (session.authenticated && session.user) {
      gameOnLogout(session.user.id).catch((err) => {
        log.debug({ error: err, node: session.nodeNumber }, 'Failed to run game logout');
      });
      auth.logoutUser(session.user.id, session.nodeNumber).catch((err) => {
        log.warn({ error: err, node: session.nodeNumber }, 'Failed to logout user on connection close');
      });
    }
    log.info({ node: session.nodeNumber }, 'Session ended');
  });

  try {
    // Welcome / Matrix screen
    frame.refresh([config.general.bbsName, 'Welcome'], HOTKEYS_MATRIX);
    drawWelcomeContent(frame, config.general.bbsName, config.general.tagline);

    // Matrix menu loop (pre-login)
    let loggedIn = false;
    while (!loggedIn) {
      // Position prompt in content area
      terminal.moveTo(frame.contentBottom, frame.contentLeft);
      terminal.write(c(Color.LightCyan, 'Select') + c(Color.DarkGray, ': ') + c(Color.White, ''));
      const choice = await terminal.readHotkey(['L', 'N', 'Q']);

      switch (choice) {
        case 'L':
          loggedIn = await handleLogin(session, frame);
          if (!loggedIn) {
            // Redraw welcome screen
            frame.refresh([config.general.bbsName, 'Welcome'], HOTKEYS_MATRIX);
            drawWelcomeContent(frame, config.general.bbsName, config.general.tagline);
          }
          break;
        case 'N':
          loggedIn = await handleNewUser(session, frame);
          if (!loggedIn) {
            frame.refresh([config.general.bbsName, 'Welcome'], HOTKEYS_MATRIX);
            drawWelcomeContent(frame, config.general.bbsName, config.general.tagline);
          }
          break;
        case 'Q':
          await handleGoodbye(session, frame);
          return;
      }
    }

    // Main menu loop
    await mainMenuLoop(session, frame);
  } catch (err) {
    if (err instanceof Error && err.message.includes('closed')) {
      // Connection closed, normal
    } else {
      const errInfo = err instanceof Error
        ? { message: err.message, stack: err.stack, name: err.name }
        : { raw: String(err), type: typeof err };
      log.error({ error: errInfo, node: session.nodeNumber }, 'Session error');
    }
  } finally {
    if (session.authenticated && session.user) {
      await auth.logoutUser(session.user.id, session.nodeNumber);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Welcome Screen Content
// ─────────────────────────────────────────────────────────────────────────────

function drawWelcomeContent(frame: ScreenFrame, bbsName: string, tagline: string): void {
  const w = frame.contentWidth;
  const BLK = BoxChars.block;

  frame.skipLine();
  frame.skipLine();

  // BBS Name centered
  frame.writeContentLine(c(Color.LightCyan, center(bbsName, w)));

  // Tagline
  frame.writeContentLine(c(Color.DarkGray, center(`< ${tagline} >`, w)));

  frame.skipLine();

  // Decorative gradient line
  const gradient =
    c(Color.DarkBlue, BLK.light.repeat(8)) +
    c(Color.DarkCyan, BLK.medium.repeat(8)) +
    c(Color.LightCyan, BLK.dark.repeat(8)) +
    c(Color.White, BLK.full.repeat(8)) +
    c(Color.LightCyan, BLK.dark.repeat(8)) +
    c(Color.DarkCyan, BLK.medium.repeat(8)) +
    c(Color.DarkBlue, BLK.light.repeat(8));
  const gradientWidth = 56;
  const gradientPad = Math.floor((w - gradientWidth) / 2);
  frame.writeContentLine(' '.repeat(gradientPad) + gradient);

  frame.skipLine();

  // Welcome text
  frame.writeContentLine(c(Color.White, '  Welcome, traveler. You have reached a place'));
  frame.writeContentLine(c(Color.White, '  where the digital frontier never faded.'));
  frame.skipLine();

  // Info line
  frame.writeContentLine(
    c(Color.DarkGray, '  Est. 2026  ') +
    c(Color.DarkCyan, '│') +
    c(Color.DarkGray, '  SSH Access  ') +
    c(Color.DarkCyan, '│') +
    c(Color.DarkGray, '  ANSI Terminal'),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Login
// ─────────────────────────────────────────────────────────────────────────────

async function handleLogin(session: Session, frame: ScreenFrame): Promise<boolean> {
  const terminal = session.terminal;
  const config = getConfig();

  frame.refresh([config.general.bbsName, 'Login'], HOTKEYS_PAUSE);

  frame.skipLine();
  frame.writeContentLine(c(Color.LightCyan, center('L O G I N', frame.contentWidth)));
  frame.skipLine();

  // Handle input
  terminal.moveTo(frame.currentRow, frame.contentLeft);
  terminal.write(c(Color.LightCyan, 'Handle: ') + c(Color.White, ''));
  const handle = await terminal.readLine({ maxLength: 30 });
  frame.setContentRow(frame.currentRow - frame.contentTop + 1);
  if (!handle) return false;

  // Password input
  terminal.moveTo(frame.currentRow, frame.contentLeft);
  terminal.write(c(Color.LightCyan, 'Password: ') + c(Color.White, ''));
  const password = await terminal.readLine({ mask: '*', maxLength: 64 });
  frame.setContentRow(frame.currentRow - frame.contentTop + 1);
  if (!password) return false;

  try {
    const user = await auth.loginUser(handle, password, session.remoteAddress, session.nodeNumber);
    session.login(user);

    frame.skipLine();
    frame.writeContentLine(c(Color.LightGreen, `Welcome back, ${user.handle}!`));
    frame.writeContentLine(c(Color.DarkGray, `Last login: ${user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'Never'}`));
    frame.writeContentLine(c(Color.DarkGray, `Call #${formatNumber(user.totalCalls)}`));

    // Game integration on login
    let game = await getPlayerGame(user.id);
    if (!game) {
      // Edge case: user exists but no game state (pre-migration). Auto-create.
      game = await createPlayerGame(user.id, 'en');
      await addGameEvent(game, 'game_start', 'Auto-created game on login', {}, 5);
      await injectGhostOneLiners(game);
    }

    await gameOnLogin(user.id);

    // Record player-scoped last caller
    const db = getDb();
    await db.lastCaller.create({
      data: { playerGameId: game.id, userId: user.id, handle: user.handle, location: user.location, node: session.nodeNumber },
    });

    // Connection effect for returning players past prologue
    if (game.chapter !== 'prologue' && game.totalSessions > 1) {
      frame.skipLine();
      await connectionEffect(terminal, frame, game.language);
    }

    // Display notifications
    try {
      const notifications = await getPendingNotifications(user.id);
      if (notifications.length > 0) {
        frame.skipLine();
        frame.writeContentLine(c(Color.Yellow, '═══ Notifications ═══'));
        for (const notif of notifications.slice(0, 5)) {
          frame.writeContentLine(c(Color.DarkGray, '► ') + c(Color.LightGray, notif.content));
        }
        await markNotificationsRead(user.id);
      }
    } catch (err) {
      log.debug({ error: err }, 'Could not check game notifications');
    }

    // NPC message triggers and auto-beats
    try {
      const context = await buildStoryContext(game);
      await checkAndSendNPCMessages(game, session.handle, context);
      await processAutoBeats(game, session, frame);
    } catch (err) {
      log.debug({ error: err }, 'Could not process game login hooks');
    }

    frame.skipLine();
    terminal.moveTo(frame.currentRow, frame.contentLeft);
    await terminal.pause();

    // New message scan (classic BBS login feature)
    await newMessageScan(game.id, session, frame);

    return true;
  } catch (err) {
    session.loginAttempts++;
    frame.skipLine();
    frame.writeContentLine(c(Color.LightRed, err instanceof Error ? err.message : 'Login failed'));

    if (session.loginAttempts >= config.auth.maxLoginAttempts) {
      frame.skipLine();
      frame.writeContentLine(c(Color.LightRed, 'Too many failed attempts. Disconnecting.'));
      await new Promise((r) => setTimeout(r, 1500));
      session.connection.close();
    } else {
      frame.skipLine();
      terminal.moveTo(frame.currentRow, frame.contentLeft);
      await terminal.pause();
    }
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// New User Registration
// ─────────────────────────────────────────────────────────────────────────────

async function handleNewUser(session: Session, frame: ScreenFrame): Promise<boolean> {
  const terminal = session.terminal;
  const config = getConfig();

  frame.refresh([config.general.bbsName, 'New User'], HOTKEYS_PAUSE);

  frame.skipLine();
  frame.writeContentLine(c(Color.LightCyan, center('N E W   U S E R', frame.contentWidth)));
  frame.skipLine();
  frame.writeContentLine(c(Color.LightGray, 'Welcome! Please fill out the following to create your account.'));
  frame.skipLine();

  const promptRow = () => {
    terminal.moveTo(frame.currentRow, frame.contentLeft);
  };

  // Handle
  promptRow();
  terminal.write(c(Color.LightCyan, 'Desired handle: ') + c(Color.White, ''));
  const handle = await terminal.readLine({ maxLength: 30 });
  frame.setContentRow(frame.currentRow - frame.contentTop + 1);
  if (!handle) return false;

  const existing = await auth.getUserByHandle(handle);
  if (existing) {
    frame.writeContentLine(c(Color.LightRed, `Handle "${handle}" is already taken.`));
    promptRow(); await terminal.pause();
    return false;
  }

  // Password
  promptRow();
  terminal.write(c(Color.LightCyan, 'Password: ') + c(Color.White, ''));
  const password = await terminal.readLine({ mask: '*', maxLength: 64 });
  frame.setContentRow(frame.currentRow - frame.contentTop + 1);
  if (!password || password.length < config.auth.minPasswordLength) {
    frame.writeContentLine(c(Color.LightRed, `Password must be at least ${config.auth.minPasswordLength} characters.`));
    promptRow(); await terminal.pause();
    return false;
  }

  // Confirm
  promptRow();
  terminal.write(c(Color.LightCyan, 'Confirm password: ') + c(Color.White, ''));
  const confirm = await terminal.readLine({ mask: '*', maxLength: 64 });
  frame.setContentRow(frame.currentRow - frame.contentTop + 1);
  if (password !== confirm) {
    frame.writeContentLine(c(Color.LightRed, 'Passwords do not match.'));
    promptRow(); await terminal.pause();
    return false;
  }

  // Location
  promptRow();
  terminal.write(c(Color.LightCyan, 'Location: ') + c(Color.White, ''));
  const location = await terminal.readLine({ maxLength: 50 });
  frame.setContentRow(frame.currentRow - frame.contentTop + 1);

  // Real name
  promptRow();
  terminal.write(c(Color.LightCyan, 'Real name (optional): ') + c(Color.White, ''));
  const realName = await terminal.readLine({ maxLength: 50 });
  frame.setContentRow(frame.currentRow - frame.contentTop + 1);

  try {
    const user = await auth.registerUser(handle, password, {
      realName: realName || undefined,
      location: location || undefined,
      accessLevel: config.general.newUserAccessLevel,
    });

    session.login(user);

    const db = getDb();
    await db.node.upsert({
      where: { nodeNumber: session.nodeNumber },
      create: { nodeNumber: session.nodeNumber, userId: user.id, remoteAddress: session.remoteAddress, connectedAt: new Date(), activity: 'Main Menu', authenticated: true },
      update: { userId: user.id, remoteAddress: session.remoteAddress, connectedAt: new Date(), activity: 'Main Menu', authenticated: true },
    });

    eventBus.emit('user:login', { nodeNumber: session.nodeNumber, userId: user.id, handle: user.handle });

    frame.skipLine();
    frame.writeContentLine(c(Color.LightGreen, `Account created! Welcome, ${user.handle}!`));
    frame.skipLine();

    // Language selection for the game
    frame.writeContentLine(c(Color.LightCyan, 'Select your language / Wähle deine Sprache:'));
    frame.skipLine();
    frame.writeContentLine(
      '  ' + c(Color.DarkCyan, '[') + c(Color.White, 'E') + c(Color.DarkCyan, '] ') + c(Color.LightGray, 'English'),
    );
    frame.writeContentLine(
      '  ' + c(Color.DarkCyan, '[') + c(Color.White, 'D') + c(Color.DarkCyan, '] ') + c(Color.LightGray, 'Deutsch'),
    );
    frame.skipLine();
    terminal.moveTo(frame.currentRow, frame.contentLeft);
    terminal.write(c(Color.LightCyan, '> ') + c(Color.White, ''));
    const langChoice = await terminal.readHotkey(['E', 'D']);
    const language = langChoice === 'D' ? 'de' : 'en';

    // Timezone selection
    let timezone = 'UTC';
    const detectedTz = session.connection.detectedTimezone;
    if (detectedTz) {
      // Web client auto-detected timezone
      timezone = detectedTz;
      frame.writeContentLine(c(Color.DarkGray, `  Timezone detected: ${detectedTz}`));
    } else {
      // SSH client — ask user to type their timezone
      frame.skipLine();
      frame.writeContentLine(c(Color.LightCyan, 'Your timezone (e.g., Europe/Berlin, America/New_York, UTC):'));
      terminal.moveTo(frame.currentRow, frame.contentLeft);
      terminal.write(c(Color.LightCyan, '> ') + c(Color.White, ''));
      const tzInput = await terminal.readLine({ maxLength: 40 });
      frame.setContentRow(frame.currentRow - frame.contentTop + 1);
      if (tzInput && tzInput.trim()) {
        timezone = tzInput.trim();
      }
    }

    // Initialize game state
    const game = await createPlayerGame(user.id, language, timezone);
    await seedPlayerContent(game.id);

    await db.lastCaller.create({
      data: { playerGameId: game.id, userId: user.id, handle: user.handle, location: user.location, node: session.nodeNumber },
    });
    await addGameEvent(game, 'game_start', `New game started, language: ${language}`, { language }, 10);
    await addStoryLogEntry(game, 'login', 'Game initialized');
    await injectGhostOneLiners(game);

    // Show prologue
    frame.refresh([config.general.bbsName], [{ key: 'Q', label: 'Continue' }]);
    frame.skipLine();
    await connectionEffect(terminal, frame, language);

    const prologue = getChapter('prologue');
    const firstBeat = prologue?.beats.find(b => b.tag === 'first_login');
    if (firstBeat?.scriptedText) {
      await sleep(500);
      displayScriptedText(frame, firstBeat.scriptedText, language, firstBeat.scriptedTextDe);
    }

    frame.skipLine();
    terminal.moveTo(frame.currentRow, frame.contentLeft);
    await terminal.pause();
    return true;
  } catch (err) {
    frame.writeContentLine(c(Color.LightRed, err instanceof Error ? err.message : 'Registration failed'));
    terminal.moveTo(frame.currentRow, frame.contentLeft);
    await terminal.pause();
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Menu
// ─────────────────────────────────────────────────────────────────────────────

async function mainMenuLoop(session: Session, frame: ScreenFrame): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();

  while (session.authenticated) {
    // Load current game state for dynamic menu
    let game = await getPlayerGame(session.user!.id);
    const menu = buildDynamicMenu(game);

    // Check for new mail and update indicator
    if (game) {
      const mailCount = await messageService.getUnreadMailCount(game.id, session.user!.id, session.handle);
      frame.hasNewMail = mailCount > 0;
    }

    frame.refresh([config.general.bbsName, 'Main Menu'], menu.hotkeys);

    frame.skipLine();
    frame.writeContentLine(c(Color.LightCyan, center('M A I N   M E N U', frame.contentWidth)));
    frame.skipLine();

    // Two-column dynamic menu layout
    const displayItems = menu.items.filter(i => i.key !== 'G'); // Goodbye rendered separately
    for (let i = 0; i < displayItems.length; i += 2) {
      const item1 = displayItems[i]!;
      const col1 =
        c(Color.DarkCyan, '[') + c(Color.White, item1.key) + c(Color.DarkCyan, '] ') +
        c(Color.LightGray, padRight(item1.label, 20));

      const item2 = displayItems[i + 1];
      if (item2) {
        const col2 =
          c(Color.DarkCyan, '[') + c(Color.White, item2.key) + c(Color.DarkCyan, '] ') +
          c(Color.LightGray, padRight(item2.label, 20));
        frame.writeContentLine('  ' + col1 + '     ' + col2);
      } else {
        frame.writeContentLine('  ' + col1);
      }
    }

    // Goodbye always last
    frame.writeContentLine(
      '  ' + c(Color.DarkCyan, '[') + c(Color.White, 'G') + c(Color.DarkCyan, '] ') +
      c(Color.DarkGray, 'Goodbye/Logoff'),
    );

    frame.skipLine();

    // Status line
    frame.writeContentLine(
      c(Color.DarkGray, 'Node: ') + c(Color.LightCyan, String(session.nodeNumber)) +
      c(Color.DarkGray, '  │  User: ') + c(Color.LightCyan, session.handle) +
      c(Color.DarkGray, '  │  ') + c(Color.DarkGray, new Date().toLocaleTimeString()),
    );

    frame.skipLine();

    // Prompt
    terminal.moveTo(frame.currentRow, frame.contentLeft);
    terminal.write(c(Color.LightCyan, 'Command') + c(Color.DarkGray, ': ') + c(Color.White, ''));

    const choice = await terminal.readHotkey(menu.keys);

    // Dispatch to module
    switch (choice) {
      case 'E': await mailModule(game!.id, session, frame); break;
      case 'M': await messageAreaModule(session, frame, game!.id); break;
      case 'O': await oneLinersModule(game!.id, session, frame); break;
      case 'W': await whoIsOnlineModule(session, frame); break;
      case 'U': await userProfileModule(session, frame); break;
      case 'L': await lastCallersModule(game!.id, session, frame); break;
      case 'B': await bulletinsModule(game!.id, session, frame); break;
      case 'V': await votingBoothModule(game!.id, session, frame); break;
      case 'D': if (game) await gamesMenu(session, frame, game); break;
      case 'T': if (game) await terminalScreen(session, frame, game); break;
      case 'F':
        if (game) {
          const ctx = await buildStoryContext(game);
          await runHiddenTerminal(session, frame, game, ctx);
        }
        break;
      case 'J': if (game) await journalScreen(session, frame, game); break;
      case 'S': await systemStatsModule(game!.id, session, frame); break;
      case 'G': await handleGoodbye(session, frame); return;
    }

    // After each action, check game progression
    if (game) {
      try {
        // Reload game state
        const refreshed = await getPlayerGame(session.user!.id);
        if (refreshed) game = refreshed;

        // Fire area_visit beat triggers
        const areaMap: Record<string, string> = {
          'M': 'messages', 'O': 'oneliners', 'W': 'whoIsOnline',
          'U': 'userProfile', 'L': 'lastCallers', 'B': 'bulletins',
          'F': 'hiddenTerminal', 'S': 'systemStats',
        };
        const visitedArea = areaMap[choice];
        if (visitedArea && game) {
          const beats = getTriggeredBeats(game, { type: 'area_visit', value: visitedArea });
          for (const beat of beats) {
            await processBeat(beat, game, session, frame, await buildStoryContext(game));
          }
        }

        // Check chapter progression
        const advanced = await checkChapterProgression(game);
        if (advanced) {
          const updatedGame = await getPlayerGame(session.user!.id);
          if (updatedGame) {
            await showChapterTransition(session, frame, updatedGame);
          }
        }
      } catch (err) {
        log.warn({ error: err }, 'Game progression check failed');
      }
    }
  }
}

async function comingSoon(session: Session, frame: ScreenFrame, from: string): Promise<void> {
  const config = getConfig();
  frame.refresh([config.general.bbsName, from, 'Coming Soon'], HOTKEYS_PAUSE);
  frame.skipLine();
  frame.writeContentLine(c(Color.Yellow, 'This feature is under construction. Check back soon!'));
  frame.skipLine();
  session.terminal.moveTo(frame.currentRow, frame.contentLeft);
  await session.terminal.pause();
}

// ─────────────────────────────────────────────────────────────────────────────
// Message Areas
// ─────────────────────────────────────────────────────────────────────────────

let currentAreaTag = 'local.general';

async function messageAreaModule(session: Session, frame: ScreenFrame, pgId: number): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();
  let selectedIndex = 0;
  let pageStart = 0;

  while (true) {
    const area = await messageService.getAreaByTag(currentAreaTag);
    const areaName = area?.name ?? currentAreaTag;
    const count = area ? await messageService.getMessageCount(pgId, area.id) : 0;
    const unread = area && session.user ? await messageService.getUnreadCount(pgId, area.id, session.user.id) : 0;

    const messages = area ? await messageService.getMessages(pgId, area.id, 500) : [];
    const sorted = [...messages].reverse();
    const lastReadId = (session.user && area)
      ? (await getDb().messageRead.findUnique({
          where: { userId_areaId: { userId: session.user.id, areaId: area.id } },
        }))?.lastReadId ?? 0
      : 0;

    // Layout constants
    const headerRows = 4; // area header + separator + column header + separator
    const footerRows = 2; // separator + prompt
    const listRows = 23 - headerRows - footerRows; // rows available for message list

    // Ensure selection stays in bounds
    if (selectedIndex >= sorted.length) selectedIndex = Math.max(0, sorted.length - 1);
    if (selectedIndex < pageStart) pageStart = selectedIndex;
    if (selectedIndex >= pageStart + listRows) pageStart = selectedIndex - listRows + 1;

    frame.refresh([config.general.bbsName, 'Messages'], [
      { key: '↑↓', label: 'Select' },
      { key: 'Enter', label: 'Read' },
      { key: 'P', label: 'Post' },
      { key: 'C', label: 'Area' },
      { key: 'Q', label: 'Back' },
    ]);

    // Area header
    frame.writeContentLine(
      c(Color.DarkBlue, ' Area: ') + c(Color.LightCyan, areaName) +
      c(Color.DarkGray, ` (${count} msgs, `) + c(Color.LightGreen, `${unread} new`) + c(Color.DarkGray, ')'),
    );
    frame.writeContentLine(c(Color.DarkGray, '─'.repeat(frame.contentWidth)));

    if (sorted.length === 0) {
      frame.skipLine();
      frame.writeContentLine(c(Color.DarkGray, '  No messages in this area.'));
      frame.skipLine();
      terminal.moveTo(frame.currentRow, frame.contentLeft);
      terminal.write(
        c(Color.DarkGray, '[') + c(Color.Yellow, 'P') + c(Color.DarkGray, ']ost [') +
        c(Color.Yellow, 'C') + c(Color.DarkGray, ']hg Area [') +
        c(Color.Yellow, 'Q') + c(Color.DarkGray, ']uit: '),
      );
      const ch = await terminal.readHotkey(['P', 'C', 'Q']);
      if (ch === 'P') { await postMessage(pgId, session, frame); continue; }
      if (ch === 'C') { await changeArea(pgId, session, frame); selectedIndex = 0; pageStart = 0; continue; }
      if (ch === 'Q') return;
      continue;
    }

    // Column header
    frame.writeContentLine(
      c(Color.DarkBlue, padRight(' #', 5)) +
      c(Color.DarkBlue, padRight('From', 16)) +
      c(Color.DarkBlue, padRight('To', 16)) +
      c(Color.DarkBlue, padRight('Subject', 25)) +
      c(Color.DarkBlue, 'Date'),
    );
    frame.writeContentLine(c(Color.DarkGray, '─'.repeat(frame.contentWidth)));

    // Message list with lightbar
    const listStartRow = frame.currentRow;
    const pageEnd = Math.min(pageStart + listRows, sorted.length);

    for (let i = pageStart; i < pageEnd; i++) {
      const msg = sorted[i]!;
      const isUnread = msg.id > lastReadId;
      const isSelected = i === selectedIndex;
      const marker = isUnread ? '*' : ' ';

      if (isSelected) {
        // Highlighted row — reverse video effect: cyan bg, black text
        frame.writeContentLine(
          setColor(Color.White, Color.DarkCyan) +
          padRight(
            `${marker}${padRight(String(i + 1), 4)}${padRight(truncate(msg.fromName, 15), 16)}${padRight(truncate(msg.toName, 15), 16)}${padRight(truncate(msg.subject, 24), 25)}${formatDate(msg.createdAt)}`,
            frame.contentWidth,
          ) + resetColor(),
        );
      } else {
        frame.writeContentLine(
          c(isUnread ? Color.LightGreen : Color.DarkGray, marker) +
          c(Color.LightCyan, padRight(String(i + 1), 4)) +
          c(Color.LightCyan, padRight(truncate(msg.fromName, 15), 16)) +
          c(Color.LightGray, padRight(truncate(msg.toName, 15), 16)) +
          c(Color.White, padRight(truncate(msg.subject, 24), 25)) +
          c(Color.DarkGray, formatDate(msg.createdAt)),
        );
      }
    }

    // Page indicator
    const totalPages = Math.ceil(sorted.length / listRows);
    const currentPage = Math.floor(pageStart / listRows) + 1;
    if (totalPages > 1) {
      frame.skipLine();
      frame.writeContentLine(
        c(Color.DarkGray, ` Page ${currentPage}/${totalPages}  (${sorted.length} messages)`),
      );
    }

    // Prompt
    terminal.moveTo(frame.contentBottom, frame.contentLeft);
    terminal.write(
      c(Color.DarkGray, '↑↓') + c(Color.DarkGray, ' Select  ') +
      c(Color.DarkGray, '[') + c(Color.Yellow, 'Enter') + c(Color.DarkGray, '] Read  ') +
      c(Color.DarkGray, '[') + c(Color.Yellow, 'P') + c(Color.DarkGray, ']ost ') +
      c(Color.DarkGray, '[') + c(Color.Yellow, 'C') + c(Color.DarkGray, ']hg ') +
      c(Color.DarkGray, '[') + c(Color.Yellow, 'Q') + c(Color.DarkGray, ']uit'),
    );

    // Input loop
    const key = await terminal.readHotkey(['UP', 'DOWN', 'PAGEUP', 'PAGEDOWN', 'ENTER', 'P', 'C', 'S', 'Q']);

    switch (key) {
      case 'UP':
        if (selectedIndex > 0) selectedIndex--;
        continue;
      case 'DOWN':
        if (selectedIndex < sorted.length - 1) selectedIndex++;
        continue;
      case 'PAGEUP':
        selectedIndex = Math.max(0, selectedIndex - listRows);
        continue;
      case 'PAGEDOWN':
        selectedIndex = Math.min(sorted.length - 1, selectedIndex + listRows);
        continue;
      case 'ENTER':
        await readMessageAt(pgId, session, frame, sorted, selectedIndex, area!);
        continue;
      case 'P':
        await postMessage(pgId, session, frame);
        continue;
      case 'C':
        await changeArea(pgId, session, frame);
        selectedIndex = 0;
        pageStart = 0;
        continue;
      case 'S':
        await scanMessages(pgId, session, frame);
        continue;
      case 'Q':
        return;
    }
  }
}

// Read a single message and allow N/P navigation from there
async function readMessageAt(
  pgId: number,
  session: Session,
  frame: ScreenFrame,
  sorted: messageService.Message[],
  startIndex: number,
  area: messageService.MessageArea,
): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();
  let index = startIndex;
  let maxReadId = 0;

  while (index >= 0 && index < sorted.length) {
    const msg = sorted[index]!;
    if (msg.id > maxReadId) maxReadId = msg.id;
    const w = frame.contentWidth;

    frame.refresh(
      [config.general.bbsName, 'Messages', area.name],
      HOTKEYS_READER,
    );

    // Classic box-drawing message header
    frame.writeContentLine(c(Color.DarkGray, '┌' + '─'.repeat(w - 2) + '┐'));
    frame.writeContentLine(
      c(Color.DarkGray, '│') +
      c(Color.DarkBlue, ' From : ') + c(Color.LightCyan, padRight(truncate(msg.fromName, 26), 26)) +
      c(Color.DarkBlue, ' Date: ') + c(Color.LightCyan, padRight(formatDateTime(msg.createdAt), 17)) +
      c(Color.DarkGray, padRight('', w - 2 - 8 - 26 - 7 - 17) + '│'),
    );
    frame.writeContentLine(
      c(Color.DarkGray, '│') +
      c(Color.DarkBlue, '   To : ') + c(Color.LightCyan, padRight(truncate(msg.toName, 26), 26)) +
      c(Color.DarkBlue, ' Msg#: ') + c(Color.LightCyan, padRight(`${index + 1} of ${sorted.length}`, 17)) +
      c(Color.DarkGray, padRight('', w - 2 - 8 - 26 - 7 - 17) + '│'),
    );
    frame.writeContentLine(
      c(Color.DarkGray, '│') +
      c(Color.DarkBlue, ' Subj : ') + c(Color.LightCyan, padRight(truncate(msg.subject, w - 12), w - 12)) +
      c(Color.DarkGray, ' │'),
    );
    frame.writeContentLine(c(Color.DarkGray, '├' + '─'.repeat(w - 2) + '┤'));

    // Body
    const bodyLines = wordWrap(msg.body, w - 3);
    for (const line of bodyLines) {
      if (frame.remainingRows <= 2) break;
      const isQuote = line.startsWith('>');
      frame.writeContentLine(
        c(Color.DarkGray, '│') + ' ' +
        c(isQuote ? Color.DarkCyan : Color.LightGray, padRight(truncate(line, w - 4), w - 4)) +
        c(Color.DarkGray, '│'),
      );
    }

    while (frame.remainingRows > 2) {
      frame.writeContentLine(
        c(Color.DarkGray, '│') + ' '.repeat(w - 2) + c(Color.DarkGray, '│'),
      );
    }
    frame.writeContentLine(c(Color.DarkGray, '└' + '─'.repeat(w - 2) + '┘'));

    // Mark read
    if (session.user) {
      await messageService.markRead(session.user.id, area.id, maxReadId);
    }

    terminal.moveTo(frame.contentBottom, frame.contentLeft);
    terminal.write(
      c(Color.DarkGray, '[') + c(Color.Yellow, 'N') + c(Color.DarkGray, ']ext ') +
      c(Color.DarkGray, '[') + c(Color.Yellow, 'P') + c(Color.DarkGray, ']rev ') +
      c(Color.DarkGray, '[') + c(Color.Yellow, 'R') + c(Color.DarkGray, ']eply ') +
      c(Color.DarkGray, '[') + c(Color.Yellow, 'Q') + c(Color.DarkGray, ']uit '),
    );

    const choice = await terminal.readHotkey(['N', 'P', 'R', 'Q']);
    switch (choice) {
      case 'N': if (index < sorted.length - 1) index++; break;
      case 'P': if (index > 0) index--; break;
      case 'R': await postMessage(pgId, session, frame, sorted[index]); break;
      case 'Q': return;
    }
  }
}

async function changeArea(pgId: number, session: Session, frame: ScreenFrame): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();

  // Build area list
  const conferences = await messageService.getConferences();
  const areaList: messageService.MessageArea[] = [];
  const items: LightbarItem[] = [];

  for (const conf of conferences) {
    if (conf.tag === 'mail' || conf.tag === 'lastlogon') continue;
    const areas = await messageService.getAreasForConference(conf.id);
    for (const a of areas) {
      areaList.push(a);
      const num = areaList.length;
      const count = await messageService.getMessageCount(pgId, a.id);
      const unread = session.user ? await messageService.getUnreadCount(pgId, a.id, session.user.id) : 0;
      const marker = currentAreaTag === a.tag ? '>' : ' ';
      const unreadStr = unread > 0 ? `${unread} new` : '';

      const plainText = ` ${marker} ${padRight(String(num), 4)}${padRight(a.name, 30)}${padRight(`${count} msgs`, 10)}${unreadStr}`;
      items.push({
        text:
          c(Color.DarkGray, ` ${marker} `) +
          c(Color.LightCyan, padRight(String(num), 4)) +
          c(Color.LightCyan, padRight(a.name, 30)) +
          c(Color.DarkGray, padRight(`${count} msgs`, 10)) +
          (unread > 0 ? c(Color.LightGreen, `${unread} new`) : ''),
        plainText,
      });
    }
  }

  if (items.length === 0) return;

  // Find current area index
  const currentIdx = areaList.findIndex(a => a.tag === currentAreaTag);

  frame.refresh([config.general.bbsName, 'Messages', 'Change Area'], [
    { key: '↑↓', label: 'Select' },
    { key: 'Enter', label: 'Choose' },
    { key: 'Q', label: 'Back' },
  ]);

  frame.writeContentLine(c(Color.Yellow, ' Select Message Area'));
  frame.writeContentLine(c(Color.DarkGray, '─'.repeat(frame.contentWidth)));

  const listRows = frame.remainingRows - 3;
  const result = await lightbarList(terminal, frame, items, Math.max(0, currentIdx), ['Q'], listRows);

  if (result.action === 'ENTER' && result.index >= 0 && result.index < areaList.length) {
    currentAreaTag = areaList[result.index]!.tag;
  }
}

// Convenience wrapper for new message scan — reads from first message in current area
async function readMessages(pgId: number, session: Session, frame: ScreenFrame): Promise<void> {
  const area = await messageService.getAreaByTag(currentAreaTag);
  if (!area) return;

  const messages = await messageService.getMessages(pgId, area.id, 500);
  if (messages.length === 0) {
    const config = getConfig();
    frame.refresh([config.general.bbsName, 'Messages', 'Read'], HOTKEYS_PAUSE);
    frame.skipLine();
    frame.writeContentLine(c(Color.DarkGray, '  No messages in this area.'));
    frame.skipLine();
    session.terminal.moveTo(frame.currentRow, frame.contentLeft);
    await session.terminal.pause();
    return;
  }

  const sorted = [...messages].reverse();
  await readMessageAt(pgId, session, frame, sorted, 0, area);
}

async function postMessage(pgId: number, session: Session, frame: ScreenFrame, replyTo?: messageService.Message): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();
  const area = await messageService.getAreaByTag(currentAreaTag);
  if (!area || !session.user) return;

  frame.refresh(
    [config.general.bbsName, 'Messages', area.name, replyTo ? 'Reply' : 'Post'],
    [{ key: 'Enter', label: 'Send' }],
  );

  frame.writeContentLine(c(Color.DarkGray, `Area: ${area.name}  From: ${session.handle}`));
  frame.skipLine();

  // To
  let toName = replyTo ? replyTo.fromName : 'All';
  terminal.moveTo(frame.currentRow, frame.contentLeft);
  terminal.write(c(Color.LightCyan, `To [${toName}]: `) + c(Color.White, ''));
  const toInput = await terminal.readLine({ maxLength: 30 });
  frame.setContentRow(frame.currentRow - frame.contentTop + 1);
  if (toInput) toName = toInput;

  // Subject
  const defaultSubject = replyTo ? `Re: ${replyTo.subject.replace(/^Re: /i, '')}` : '';
  terminal.moveTo(frame.currentRow, frame.contentLeft);
  terminal.write(c(Color.LightCyan, `Subject${defaultSubject ? ` [${truncate(defaultSubject, 25)}]` : ''}: `) + c(Color.White, ''));
  const subjectInput = await terminal.readLine({ maxLength: 72 });
  frame.setContentRow(frame.currentRow - frame.contentTop + 1);
  const subject = subjectInput || defaultSubject;
  if (!subject) {
    frame.writeContentLine(c(Color.LightRed, 'Subject is required.'));
    terminal.moveTo(frame.currentRow, frame.contentLeft);
    await terminal.pause();
    return;
  }

  frame.skipLine();

  // Pre-fill quote if replying
  let prefill = '';
  if (replyTo) {
    const quoteLines = replyTo.body.split('\n').slice(0, 4);
    prefill = quoteLines.map(l => `> ${l}`).join('\n') + '\n\n';
  }

  frame.writeContentLine(c(Color.DarkGray, 'Type your message (two blank Enters or Esc to finish):'));
  frame.writeContentLine(c(Color.DarkCyan, '─'.repeat(frame.contentWidth)));

  // Show prefilled quote text
  if (prefill) {
    for (const line of prefill.split('\n')) {
      frame.writeContentLine(c(Color.DarkCyan, line));
    }
  }

  terminal.write(resetColor());
  const editorRow = frame.currentRow;
  const editorRows = frame.remainingRows - 2;

  const bodyLines = await terminal.readTextBlock({
    startRow: editorRow,
    startCol: frame.contentLeft,
    width: frame.contentWidth,
    maxRows: editorRows,
  });

  // Prepend quote lines if replying
  const allLines = prefill ? [...prefill.trimEnd().split('\n'), ...bodyLines] : bodyLines;

  // Trim trailing empty lines
  while (allLines.length > 0 && allLines[allLines.length - 1] === '') {
    allLines.pop();
  }

  if (allLines.length === 0) {
    frame.setContentRow(editorRow - frame.contentTop + editorRows);
    frame.writeContentLine(c(Color.LightRed, 'Message aborted (empty body).'));
    terminal.moveTo(frame.currentRow, frame.contentLeft);
    await terminal.pause();
    return;
  }

  terminal.moveTo(frame.currentRow, frame.contentLeft);
  const save = await terminal.promptYesNo(c(Color.LightCyan, 'Save this message?'));

  if (save) {
    await messageService.postMessage(pgId, area.id, session.user.id, session.handle, subject, allLines.join('\n'), {
      toName,
      replyToId: replyTo?.id,
    });
    terminal.moveTo(frame.currentRow + 1, frame.contentLeft);
    terminal.write(c(Color.LightGreen, 'Message posted!'));
  } else {
    terminal.moveTo(frame.currentRow + 1, frame.contentLeft);
    terminal.write(c(Color.Yellow, 'Message aborted.'));
  }
  await new Promise((r) => setTimeout(r, 1000));
}

async function scanMessages(pgId: number, session: Session, frame: ScreenFrame): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();
  if (!session.user) return;

  frame.refresh([config.general.bbsName, 'Messages', 'Scan'], HOTKEYS_PAUSE);

  frame.skipLine();
  frame.writeContentLine(c(Color.LightCyan, 'Scanning for new messages...'));
  frame.skipLine();

  const areas = await messageService.getAllAreas();
  let totalNew = 0;

  for (const a of areas) {
    const unread = await messageService.getUnreadCount(pgId, a.id, session.user.id);
    if (unread > 0) {
      frame.writeContentLine(
        c(Color.LightCyan, padRight(a.name, 33)) +
        c(Color.LightGreen, `${unread} new message${unread !== 1 ? 's' : ''}`),
      );
      totalNew += unread;
    }
  }

  if (totalNew === 0) {
    frame.writeContentLine(c(Color.DarkGray, 'No new messages.'));
  } else {
    frame.skipLine();
    frame.writeContentLine(c(Color.White, `Total: ${totalNew} new message${totalNew !== 1 ? 's' : ''}`));
  }

  frame.skipLine();
  terminal.moveTo(frame.currentRow, frame.contentLeft);
  await terminal.pause();
}

// ─────────────────────────────────────────────────────────────────────────────
// Personal Mail
// ─────────────────────────────────────────────────────────────────────────────

async function mailModule(pgId: number, session: Session, frame: ScreenFrame): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();
  if (!session.user) return;
  let selectedIndex = 0;

  while (true) {
    const mail = await messageService.getMailForUser(pgId, session.handle, 50);
    const mailAreaId = await messageService.getMailAreaId();
    const lastReadId = mailAreaId
      ? (await getDb().messageRead.findUnique({
          where: { userId_areaId: { userId: session.user.id, areaId: mailAreaId } },
        }))?.lastReadId ?? 0
      : 0;

    frame.refresh([config.general.bbsName, 'Mail'], [
      { key: '↑↓', label: 'Select' },
      { key: 'Enter', label: 'Read' },
      { key: 'W', label: 'Write' },
      { key: 'Q', label: 'Back' },
    ]);

    frame.writeContentLine(
      c(Color.DarkBlue, ' Personal Mail for ') + c(Color.LightCyan, session.handle),
    );
    frame.writeContentLine(c(Color.DarkGray, '─'.repeat(frame.contentWidth)));

    if (mail.length === 0) {
      frame.skipLine();
      frame.writeContentLine(c(Color.DarkGray, '  No mail messages.'));
      frame.skipLine();
      terminal.moveTo(frame.currentRow, frame.contentLeft);
      terminal.write(
        c(Color.DarkGray, '[') + c(Color.Yellow, 'W') + c(Color.DarkGray, ']rite ') +
        c(Color.DarkGray, '[') + c(Color.Yellow, 'Q') + c(Color.DarkGray, ']uit '),
      );
      const ch = await terminal.readHotkey(['W', 'Q']);
      if (ch === 'Q') return;
      if (ch === 'W') { await writeMailScreen(pgId, session, frame); continue; }
      continue;
    }

    // Column header
    frame.writeContentLine(
      c(Color.DarkBlue, padRight(' #', 5)) +
      c(Color.DarkBlue, padRight('From', 18)) +
      c(Color.DarkBlue, padRight('Subject', 35)) +
      c(Color.DarkBlue, 'Date'),
    );
    frame.writeContentLine(c(Color.DarkGray, '─'.repeat(frame.contentWidth)));

    // Build lightbar items
    const items: LightbarItem[] = mail.map((msg, i) => {
      const isUnread = msg.id > lastReadId;
      const marker = isUnread ? '*' : ' ';
      return {
        text:
          c(isUnread ? Color.LightGreen : Color.DarkGray, marker) +
          c(Color.LightCyan, padRight(String(i + 1), 4)) +
          c(Color.LightCyan, padRight(truncate(msg.fromName, 17), 18)) +
          c(Color.White, padRight(truncate(msg.subject, 34), 35)) +
          c(Color.DarkGray, formatDate(msg.createdAt)),
        plainText:
          `${marker}${padRight(String(i + 1), 4)}${padRight(truncate(msg.fromName, 17), 18)}${padRight(truncate(msg.subject, 34), 35)}${formatDate(msg.createdAt)}`,
      };
    });

    const listRows = frame.remainingRows - 3;
    const result = await lightbarList(terminal, frame, items, selectedIndex, ['W', 'Q'], listRows);
    selectedIndex = result.index;

    if (result.action === 'Q') return;
    if (result.action === 'W') { await writeMailScreen(pgId, session, frame); continue; }
    if (result.action === 'ENTER' && mail.length > 0) {
      // Read from selected message using the shared reader
      const area = mailAreaId ? await messageService.getAreaByTag('mail.personal') : null;
      if (area) {
        await readMessageAt(pgId, session, frame, mail, result.index, area);
      }
    }
  }
}

async function writeMailScreen(pgId: number, session: Session, frame: ScreenFrame): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();
  if (!session.user) return;

  frame.refresh([config.general.bbsName, 'Mail', 'Write'], [{ key: 'Enter', label: 'Send' }]);
  frame.skipLine();

  terminal.moveTo(frame.currentRow, frame.contentLeft);
  terminal.write(c(Color.DarkBlue, 'To: ') + c(Color.White, ''));
  const toName = await terminal.readLine({ maxLength: 30 });
  frame.setContentRow(frame.currentRow - frame.contentTop + 1);
  if (!toName) return;

  terminal.moveTo(frame.currentRow, frame.contentLeft);
  terminal.write(c(Color.DarkBlue, 'Subject: ') + c(Color.White, ''));
  const subject = await terminal.readLine({ maxLength: 60 });
  frame.setContentRow(frame.currentRow - frame.contentTop + 1);
  if (!subject) return;

  frame.skipLine();
  frame.writeContentLine(c(Color.DarkGray, 'Type your message (two blank Enters or Esc to finish):'));
  frame.writeContentLine(c(Color.DarkGray, '─'.repeat(frame.contentWidth)));

  terminal.write(resetColor());
  const editorRow = frame.currentRow;
  const editorRows = frame.remainingRows - 2;

  const bodyLines = await terminal.readTextBlock({
    startRow: editorRow,
    startCol: frame.contentLeft,
    width: frame.contentWidth,
    maxRows: editorRows,
  });

  if (bodyLines.length > 0) {
    frame.setContentRow(editorRow - frame.contentTop + editorRows);
    terminal.moveTo(frame.currentRow, frame.contentLeft);
    const save = await terminal.promptYesNo(c(Color.Yellow, 'Send this mail?'));
    if (save) {
      await messageService.sendMail(pgId, session.user.id, session.handle, toName, subject, bodyLines.join('\n'));
      terminal.write(c(Color.LightGreen, ' Mail sent!'));
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// ─── Bulletins ──────────────────────────────────────────────────────────────

async function bulletinsModule(pgId: number, session: Session, frame: ScreenFrame): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();
  const db = getDb();

  const bulletins = await db.bulletin.findMany({
    where: { playerGameId: pgId, active: true },
    orderBy: { number: 'asc' },
  });

  if (bulletins.length === 0) {
    frame.refresh([config.general.bbsName, 'Bulletins'], HOTKEYS_PAUSE);
    frame.skipLine();
    frame.writeContentLine(c(Color.DarkGray, '  No bulletins available.'));
    frame.skipLine();
    terminal.moveTo(frame.currentRow, frame.contentLeft);
    await terminal.pause();
    return;
  }

  // Build lightbar items
  const items: LightbarItem[] = bulletins.map((b, i) => ({
    text:
      c(Color.LightCyan, padRight(`#${b.number}`, 5)) +
      c(Color.White, padRight(truncate(b.title, 55), 55)) +
      c(Color.DarkGray, formatDate(b.createdAt)),
    plainText: `#${padRight(String(b.number), 4)}${padRight(truncate(b.title, 55), 55)}${formatDate(b.createdAt)}`,
  }));

  let selectedIndex = 0;

  while (true) {
    frame.refresh([config.general.bbsName, 'Bulletins'], [
      { key: '↑↓', label: 'Select' },
      { key: 'Enter', label: 'Read' },
      { key: 'Q', label: 'Back' },
    ]);

    frame.writeContentLine(c(Color.Yellow, ' System Bulletins'));
    frame.writeContentLine(c(Color.DarkGray, '─'.repeat(frame.contentWidth)));

    const listRows = frame.remainingRows - 3;
    const result = await lightbarList(terminal, frame, items, selectedIndex, ['Q'], listRows);
    selectedIndex = result.index;

    if (result.action === 'Q') return;

    if (result.action === 'ENTER' && selectedIndex < bulletins.length) {
      // Read the selected bulletin
      const bulletin = bulletins[selectedIndex]!;
      const w = frame.contentWidth;

      frame.refresh([config.general.bbsName, 'Bulletins', `#${bulletin.number}`], HOTKEYS_PAUSE);

      frame.writeContentLine(c(Color.DarkGray, '┌' + '─'.repeat(w - 2) + '┐'));
      frame.writeContentLine(
        c(Color.DarkGray, '│') +
        c(Color.Yellow, ` Bulletin #${bulletin.number}: `) +
        c(Color.White, padRight(truncate(bulletin.title, w - 17), w - 17)) +
        c(Color.DarkGray, '│'),
      );
      frame.writeContentLine(c(Color.DarkGray, '├' + '─'.repeat(w - 2) + '┤'));

      // Render body with pipe codes
      const bodyText = bulletin.body ?? '';
      const bodyLines = bodyText.split('\n');
      for (const line of bodyLines) {
        if (frame.remainingRows <= 2) break;
        frame.writeContentLine(
          c(Color.DarkGray, '│') + ' ' +
          parsePipeCodes(padRight(truncate(line.trimEnd(), w - 4), w - 4)) +
          c(Color.DarkGray, '│'),
        );
      }

      while (frame.remainingRows > 2) {
        frame.writeContentLine(c(Color.DarkGray, '│') + ' '.repeat(w - 2) + c(Color.DarkGray, '│'));
      }
      frame.writeContentLine(c(Color.DarkGray, '└' + '─'.repeat(w - 2) + '┘'));

      terminal.moveTo(frame.contentBottom, frame.contentLeft);
      await terminal.pause();
    }
  }
}

// ─── Voting Booth ───────────────────────────────────────────────────────────

async function votingBoothModule(pgId: number, session: Session, frame: ScreenFrame): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();
  const db = getDb();
  if (!session.user) return;

  const polls = await db.poll.findMany({
    where: { playerGameId: pgId, active: true },
    include: {
      options: { orderBy: { sortOrder: 'asc' } },
      votes: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  if (polls.length === 0) {
    frame.refresh([config.general.bbsName, 'Voting Booth'], HOTKEYS_PAUSE);
    frame.skipLine();
    frame.writeContentLine(c(Color.DarkGray, '  No active polls.'));
    frame.skipLine();
    terminal.moveTo(frame.currentRow, frame.contentLeft);
    await terminal.pause();
    return;
  }

  // Build lightbar items
  const items: LightbarItem[] = polls.map(p => {
    const voteCount = p.votes.length;
    const hasVoted = p.votes.some(v => v.userId === session.user!.id);
    const marker = hasVoted ? c(Color.LightGreen, '✓') : ' ';
    return {
      text: marker + ' ' +
        c(Color.White, padRight(truncate(p.question, 55), 55)) +
        c(Color.DarkGray, `${voteCount} votes`),
      plainText: `${hasVoted ? '✓' : ' '} ${padRight(truncate(p.question, 55), 55)}${voteCount} votes`,
    };
  });

  let selectedIndex = 0;

  while (true) {
    frame.refresh([config.general.bbsName, 'Voting Booth'], [
      { key: '↑↓', label: 'Select' },
      { key: 'Enter', label: 'Vote' },
      { key: 'Q', label: 'Back' },
    ]);

    frame.writeContentLine(c(Color.Yellow, ' Active Polls'));
    frame.writeContentLine(c(Color.DarkGray, '─'.repeat(frame.contentWidth)));

    const listRows = frame.remainingRows - 3;
    const result = await lightbarList(terminal, frame, items, selectedIndex, ['Q'], listRows);
    selectedIndex = result.index;

    if (result.action === 'Q') return;

    if (result.action === 'ENTER' && selectedIndex < polls.length) {
      const poll = polls[selectedIndex]!;
      const hasVoted = poll.votes.some(v => v.userId === session.user!.id);

      frame.refresh([config.general.bbsName, 'Voting Booth', 'Poll'], HOTKEYS_PAUSE);
      frame.skipLine();
      frame.writeContentLine(c(Color.White, ` ${poll.question}`));
      frame.skipLine();

      // Show options with vote counts
      const totalVotes = poll.votes.length;
      for (let i = 0; i < poll.options.length; i++) {
        const opt = poll.options[i]!;
        const optVotes = poll.votes.filter(v => v.optionId === opt.id).length;
        const pct = totalVotes > 0 ? Math.round((optVotes / totalVotes) * 100) : 0;
        const barLen = totalVotes > 0 ? Math.round((optVotes / totalVotes) * 30) : 0;
        const bar = '█'.repeat(barLen) + '░'.repeat(30 - barLen);

        frame.writeContentLine(
          '  ' + c(Color.DarkCyan, `[${i + 1}]`) + ' ' +
          c(Color.LightGray, padRight(opt.text, 25)) +
          c(Color.DarkCyan, bar) + ' ' +
          c(Color.LightCyan, `${pct}%`) +
          c(Color.DarkGray, ` (${optVotes})`),
        );
      }

      frame.skipLine();

      if (hasVoted) {
        frame.writeContentLine(c(Color.DarkGray, '  You have already voted on this poll.'));
        terminal.moveTo(frame.currentRow, frame.contentLeft);
        await terminal.pause();
      } else {
        terminal.moveTo(frame.currentRow, frame.contentLeft);
        terminal.write(c(Color.Yellow, '  Vote #') + c(Color.DarkGray, ' (or Q to skip): ') + c(Color.White, ''));
        const input = await terminal.readLine({ maxLength: 2 });

        if (input && input.toUpperCase() !== 'Q') {
          const optNum = parseInt(input, 10);
          if (optNum >= 1 && optNum <= poll.options.length) {
            const option = poll.options[optNum - 1]!;
            await db.pollVote.create({
              data: {
                pollId: poll.id,
                optionId: option.id,
                userId: session.user.id,
              },
            });
            terminal.write(c(Color.LightGreen, ' Vote recorded!'));
            await new Promise(r => setTimeout(r, 1000));
            // Refresh poll data
            return votingBoothModule(pgId, session, frame);
          }
        }
      }
    }
  }
}

// ─── New Message Scan (classic BBS login feature) ───────────────────────────

async function newMessageScan(pgId: number, session: Session, frame: ScreenFrame): Promise<void> {
  if (!session.user) return;

  try {
    const terminal = session.terminal;
    const config = getConfig();

    const areas = await messageService.getAllAreas();
    const unreadAreas: { name: string; count: number }[] = [];

    for (const a of areas) {
      // Skip game-internal and mail areas
      if (a.tag.startsWith('lastlogon') || a.tag.startsWith('mail')) continue;
      const unread = await messageService.getUnreadCount(pgId, a.id, session.user!.id);
      if (unread > 0) {
        unreadAreas.push({ name: a.name, count: unread });
      }
    }

    const mailCount = await messageService.getUnreadMailCount(pgId, session.user.id, session.handle);

    if (unreadAreas.length === 0 && mailCount === 0) return;

    frame.refresh([config.general.bbsName, 'New Messages'], HOTKEYS_PAUSE);
    frame.skipLine();
    frame.writeContentLine(c(Color.Yellow, ' Scanning for new messages...'));
    frame.skipLine();

    if (mailCount > 0) {
      frame.writeContentLine(
        c(Color.LightRed, '  ► ') + c(Color.White, `You have ${mailCount} new mail!`),
      );
    }

    for (const a of unreadAreas) {
      frame.writeContentLine(
        c(Color.LightCyan, '  ' + padRight(a.name, 35)) +
        c(Color.LightGreen, `${a.count} new`),
      );
    }

    const total = unreadAreas.reduce((s, a) => s + a.count, 0) + mailCount;
    frame.skipLine();
    frame.writeContentLine(c(Color.White, `  ${total} new message${total !== 1 ? 's' : ''} total.`));
    frame.skipLine();

    terminal.moveTo(frame.currentRow, frame.contentLeft);
    await terminal.pause();
  } catch (err) {
    log.debug({ error: err }, 'New message scan failed');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Who's Online
// ─────────────────────────────────────────────────────────────────────────────

async function whoIsOnlineModule(session: Session, frame: ScreenFrame): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();
  const db = getDb();

  frame.refresh([config.general.bbsName, 'Who\'s Online'], HOTKEYS_PAUSE);

  frame.skipLine();

  frame.writeContentLine(
    c(Color.Yellow, padRight('Node', 6) + padRight('Handle', 20) + padRight('Activity', 25) + 'Connected'),
  );
  frame.writeContentLine(c(Color.DarkCyan, '─'.repeat(frame.contentWidth)));

  const nodes = await db.node.findMany({
    where: { authenticated: true },
    include: { user: { select: { handle: true } } },
    orderBy: { nodeNumber: 'asc' },
  });

  for (const node of nodes) {
    frame.writeContentLine(
      c(Color.White, padRight(String(node.nodeNumber), 6)) +
      c(Color.LightCyan, padRight(node.user?.handle ?? 'Unknown', 20)) +
      c(Color.LightGray, padRight(node.activity ?? 'Idle', 25)) +
      c(Color.DarkGray, node.connectedAt ? formatDateTime(node.connectedAt) : ''),
    );
  }

  if (nodes.length === 0) {
    frame.writeContentLine(c(Color.DarkGray, 'No other users online.'));
  }

  frame.skipLine();
  terminal.moveTo(frame.currentRow, frame.contentLeft);
  await terminal.pause();
}

// ─────────────────────────────────────────────────────────────────────────────
// User Profile
// ─────────────────────────────────────────────────────────────────────────────

async function userProfileModule(session: Session, frame: ScreenFrame): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();
  if (!session.user) return;

  frame.refresh([config.general.bbsName, 'User Profile'], HOTKEYS_PAUSE);

  frame.skipLine();
  frame.writeContentLine(c(Color.LightCyan, center('U S E R   P R O F I L E', frame.contentWidth)));
  frame.skipLine();

  const u = session.user;
  const fields: [string, string][] = [
    ['Handle', u.handle],
    ['Real Name', u.realName ?? '(not set)'],
    ['Location', u.location || '(not set)'],
    ['Affiliation', u.affiliation || '(not set)'],
    ['Access Level', String(u.accessLevel)],
    ['Total Calls', formatNumber(u.totalCalls)],
    ['Total Posts', formatNumber(u.totalPosts)],
    ['First Login', u.firstLoginAt ? formatDateTime(u.firstLoginAt) : 'N/A'],
    ['Last Login', u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'N/A'],
    ['Member Since', formatDateTime(u.createdAt)],
  ];

  for (const [label, value] of fields) {
    frame.writeContentLine(
      c(Color.LightCyan, padRight(label + ':', 18)) + c(Color.White, value),
    );
  }

  frame.skipLine();
  terminal.moveTo(frame.currentRow, frame.contentLeft);
  await terminal.pause();
}

// ─────────────────────────────────────────────────────────────────────────────
// Last Callers
// ─────────────────────────────────────────────────────────────────────────────

async function lastCallersModule(pgId: number, session: Session, frame: ScreenFrame): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();
  const db = getDb();

  frame.refresh([config.general.bbsName, 'Last Callers'], HOTKEYS_PAUSE);

  frame.skipLine();

  frame.writeContentLine(
    c(Color.Yellow, padRight('Handle', 18) + padRight('Location', 28) + padRight('Node', 6) + 'Login Time'),
  );
  frame.writeContentLine(c(Color.DarkCyan, '─'.repeat(frame.contentWidth)));

  const callers = await db.lastCaller.findMany({
    where: { playerGameId: pgId },
    orderBy: { loginAt: 'desc' },
    take: 18,
  });

  for (const caller of callers) {
    frame.writeContentLine(
      c(Color.LightCyan, padRight(caller.handle, 18)) +
      c(Color.LightGray, padRight(caller.location ?? '', 28)) +
      c(Color.DarkGray, padRight(caller.node != null ? String(caller.node) : '', 6)) +
      c(Color.DarkGray, formatDateTime(caller.loginAt)),
    );
  }

  if (callers.length === 0) {
    frame.writeContentLine(c(Color.DarkGray, 'No callers yet. You\'re the first!'));
  }

  frame.skipLine();
  terminal.moveTo(frame.currentRow, frame.contentLeft);
  await terminal.pause();
}

// ─────────────────────────────────────────────────────────────────────────────
// One-Liners
// ─────────────────────────────────────────────────────────────────────────────

async function oneLinersModule(pgId: number, session: Session, frame: ScreenFrame): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();
  const db = getDb();

  frame.refresh(
    [config.general.bbsName, 'One-Liners'],
    [{ key: 'A', label: 'Add' }, { key: 'Q', label: 'Back' }],
  );

  frame.skipLine();
  frame.writeContentLine(c(Color.LightCyan, center('O N E - L I N E R S', frame.contentWidth)));
  frame.skipLine();

  const liners = await db.oneliner.findMany({
    where: { playerGameId: pgId },
    orderBy: { postedAt: 'desc' },
    take: 15,
  });

  for (const liner of liners) {
    frame.writeContentLine(
      c(Color.LightCyan, padRight(liner.handle, 14)) +
      c(Color.LightGray, truncate(liner.text, frame.contentWidth - 14)),
    );
  }

  if (liners.length === 0) {
    frame.writeContentLine(c(Color.DarkGray, 'No one-liners yet. Be the first!'));
  }

  frame.skipLine();

  if (session.user) {
    terminal.moveTo(frame.currentRow, frame.contentLeft);
    const choice = await terminal.readHotkey(['A', 'Q']);
    if (choice === 'A') {
      terminal.moveTo(frame.currentRow, frame.contentLeft);
      terminal.write(c(Color.LightCyan, 'Your one-liner: ') + c(Color.White, ''));
      const text = await terminal.readLine({ maxLength: 65 });
      if (text) {
        await db.oneliner.create({
          data: { playerGameId: pgId, userId: session.user.id, handle: session.handle, text },
        });
      }
    }
  } else {
    terminal.moveTo(frame.currentRow, frame.contentLeft);
    await terminal.pause();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// System Stats
// ─────────────────────────────────────────────────────────────────────────────

async function systemStatsModule(pgId: number, session: Session, frame: ScreenFrame): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();
  const db = getDb();

  frame.refresh([config.general.bbsName, 'System Stats'], HOTKEYS_PAUSE);

  frame.skipLine();
  frame.writeContentLine(c(Color.LightCyan, center('S Y S T E M   S T A T S', frame.contentWidth)));
  frame.skipLine();

  const userCount = await db.user.count();
  const msgCount = await db.message.count({ where: { playerGameId: pgId } });
  const areaCount = await db.messageArea.count();
  const onlineCount = await db.node.count({ where: { authenticated: true } });
  const callsAgg = await db.user.aggregate({ _sum: { totalCalls: true } });
  const callCount = callsAgg._sum.totalCalls ?? 0;

  const stats: [string, string][] = [
    ['BBS Name', config.general.bbsName],
    ['SysOp', config.general.sysopName],
    ['Tagline', config.general.tagline],
  ];
  for (const [l, v] of stats) {
    frame.writeContentLine(c(Color.LightCyan, padRight(l + ':', 20)) + c(Color.White, v));
  }

  frame.skipLine();

  const nums: [string, string][] = [
    ['Total Users', formatNumber(userCount)],
    ['Total Messages', formatNumber(msgCount)],
    ['Message Areas', formatNumber(areaCount)],
    ['Total Calls', formatNumber(callCount)],
    ['Users Online', `${onlineCount} of ${config.general.maxNodes} nodes`],
  ];
  for (const [l, v] of nums) {
    frame.writeContentLine(c(Color.LightCyan, padRight(l + ':', 20)) + c(Color.White, v));
  }

  frame.skipLine();
  terminal.moveTo(frame.currentRow, frame.contentLeft);
  await terminal.pause();
}

// ─────────────────────────────────────────────────────────────────────────────
// Goodbye
// ─────────────────────────────────────────────────────────────────────────────

async function handleGoodbye(session: Session, frame: ScreenFrame): Promise<void> {
  const config = getConfig();

  frame.refresh([config.general.bbsName, 'Goodbye'], []);

  frame.skipLine();
  frame.skipLine();
  frame.writeContentLine(c(Color.LightCyan, center('G O O D B Y E !', frame.contentWidth)));
  frame.skipLine();
  frame.writeContentLine(c(Color.LightGray, center(`Thank you for visiting ${config.general.bbsName}!`, frame.contentWidth)));
  frame.writeContentLine(c(Color.LightGray, center('Come back soon, traveler.', frame.contentWidth)));
  frame.skipLine();
  frame.writeContentLine(c(Color.DarkGray, center(config.general.tagline, frame.contentWidth)));

  await new Promise((r) => setTimeout(r, 1500));

  if (session.authenticated && session.user) {
    await gameOnLogout(session.user.id).catch(() => {});
    await auth.logoutUser(session.user.id, session.nodeNumber);
    session.logout();
  }

  session.connection.close();
}
