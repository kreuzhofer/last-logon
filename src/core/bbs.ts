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
import { padRight, center, formatDateTime, truncate, wordWrap, formatNumber } from '../utils/string-utils.js';
import { lastLogonDoor } from '../game/index.js';
import { onPlayerLogin as gameOnLogin, onPlayerLogout as gameOnLogout, getPendingNotifications } from '../game/game-layer.js';
import { startGameScheduler } from '../game/scheduler.js';

const log = createChildLogger('bbs');

// Shorthand color helpers
function c(fg: Color, text: string): string {
  return setColor(fg) + text;
}
function cr(): string {
  return resetColor();
}

// Common hotkey sets
const HOTKEYS_MATRIX: HotkeyDef[] = [
  { key: 'L', label: 'Login' },
  { key: 'N', label: 'New User' },
  { key: 'Q', label: 'Quit' },
];

const HOTKEYS_MAIN: HotkeyDef[] = [
  { key: 'M', label: 'Msgs' },
  { key: 'F', label: 'Files' },
  { key: 'D', label: 'Doors' },
  { key: 'W', label: 'Who' },
  { key: 'U', label: 'User' },
  { key: 'O', label: '1Liner' },
  { key: 'S', label: 'Stats' },
  { key: 'G', label: 'Bye' },
];

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
      log.error({ error: err, node: session.nodeNumber }, 'Session error');
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

    // Check for Last Logon game notifications
    try {
      const gameNotifs = await getPendingNotifications(user.id);
      if (gameNotifs.length > 0) {
        frame.skipLine();
        frame.writeContentLine(c(Color.LightRed, `You have ${gameNotifs.length} notification(s) from Last Logon...`));
      }
    } catch (err) {
      log.debug({ error: err }, 'Could not check game notifications');
    }

    frame.skipLine();

    terminal.moveTo(frame.currentRow, frame.contentLeft);
    await terminal.pause();
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

    await db.lastCaller.create({
      data: { userId: user.id, handle: user.handle, location: user.location, node: session.nodeNumber },
    });

    eventBus.emit('user:login', { nodeNumber: session.nodeNumber, userId: user.id, handle: user.handle });

    frame.skipLine();
    frame.writeContentLine(c(Color.LightGreen, `Account created! Welcome, ${user.handle}!`));
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
    frame.refresh([config.general.bbsName, 'Main Menu'], HOTKEYS_MAIN);

    frame.skipLine();
    frame.writeContentLine(c(Color.LightCyan, center('M A I N   M E N U', frame.contentWidth)));
    frame.skipLine();

    // Two-column menu
    const items: [string, string, string, string][] = [
      ['M', 'Message Areas', 'U', 'User Profile'],
      ['F', 'File Areas', 'W', 'Who\'s Online'],
      ['D', 'Last Logon', 'L', 'Last Callers'],
      ['C', 'Chat/Conference', 'O', 'One-Liners'],
      ['B', 'Bulletins', 'V', 'Voting Booth'],
      ['S', 'System Stats', 'G', 'Goodbye/Logoff'],
    ];

    for (const [k1, l1, k2, l2] of items) {
      const col1 =
        c(Color.DarkCyan, '[') + c(Color.White, k1) + c(Color.DarkCyan, '] ') +
        c(Color.LightGray, padRight(l1, 20));
      const col2 =
        c(Color.DarkCyan, '[') + c(Color.White, k2) + c(Color.DarkCyan, '] ') +
        c(Color.LightGray, padRight(l2, 20));
      frame.writeContentLine('  ' + col1 + '     ' + col2);
    }

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

    const choice = await terminal.readHotkey([
      'M', 'F', 'D', 'C', 'O', 'W', 'U', 'L', 'B', 'V', 'S', 'G',
    ]);

    switch (choice) {
      case 'M': await messageAreaModule(session, frame); break;
      case 'W': await whoIsOnlineModule(session, frame); break;
      case 'U': await userProfileModule(session, frame); break;
      case 'L': await lastCallersModule(session, frame); break;
      case 'O': await oneLinersModule(session, frame); break;
      case 'S': await systemStatsModule(session, frame); break;
      case 'G': await handleGoodbye(session, frame); return;
      case 'D': await lastLogonDoor(session, frame); break;
      case 'F': case 'C': case 'B': case 'V':
        await comingSoon(session, frame, 'Main Menu');
        break;
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

async function messageAreaModule(session: Session, frame: ScreenFrame): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();

  while (true) {
    frame.refresh([config.general.bbsName, 'Main Menu', 'Messages'], HOTKEYS_MESSAGES);

    frame.skipLine();
    frame.writeContentLine(c(Color.LightCyan, center('M E S S A G E   A R E A S', frame.contentWidth)));
    frame.skipLine();

    // Current area info
    const area = await messageService.getAreaByTag(currentAreaTag);
    if (area) {
      const count = await messageService.getMessageCount(area.id);
      const unread = session.user ? await messageService.getUnreadCount(area.id, session.user.id) : 0;
      frame.writeContentLine(
        c(Color.DarkGray, 'Current: ') +
        c(Color.LightCyan, area.name) +
        c(Color.DarkGray, ` (${count} msgs, ${unread} new)`),
      );
    }

    frame.skipLine();

    const menuItems = [
      ['R', 'Read Messages'],
      ['P', 'Post New Message'],
      ['S', 'Scan New Messages'],
      ['C', 'Change Area'],
      ['Q', 'Return to Main Menu'],
    ];
    for (const [k, l] of menuItems) {
      frame.writeContentLine(
        '  ' + c(Color.DarkCyan, '[') + c(Color.White, k!) + c(Color.DarkCyan, '] ') +
        c(Color.LightGray, l!),
      );
    }

    frame.skipLine();
    terminal.moveTo(frame.currentRow, frame.contentLeft);
    terminal.write(c(Color.LightCyan, 'Command') + c(Color.DarkGray, ': ') + c(Color.White, ''));
    const choice = await terminal.readHotkey(['R', 'P', 'S', 'C', 'Q']);

    switch (choice) {
      case 'R': await readMessages(session, frame); break;
      case 'P': await postMessage(session, frame); break;
      case 'S': await scanMessages(session, frame); break;
      case 'C': await changeArea(session, frame); break;
      case 'Q': return;
    }
  }
}

async function changeArea(session: Session, frame: ScreenFrame): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();

  frame.refresh([config.general.bbsName, 'Messages', 'Change Area'], HOTKEYS_PAUSE);

  frame.skipLine();

  const conferences = await messageService.getConferences();
  const areaList: messageService.MessageArea[] = [];

  for (const conf of conferences) {
    frame.writeContentLine(c(Color.Yellow, conf.name));
    if (conf.description) {
      frame.writeContentLine(c(Color.DarkGray, conf.description));
    }

    const areas = await messageService.getAreasForConference(conf.id);
    for (const a of areas) {
      areaList.push(a);
      const num = areaList.length;
      const count = await messageService.getMessageCount(a.id);
      const unread = session.user ? await messageService.getUnreadCount(a.id, session.user.id) : 0;
      const marker = currentAreaTag === a.tag ? '>' : ' ';
      const unreadStr = unread > 0 ? c(Color.LightGreen, ` (${unread} new)`) : '';

      frame.writeContentLine(
        c(Color.DarkGray, ` ${marker} `) +
        c(Color.White, padRight(`${num}`, 3)) +
        c(Color.LightCyan, padRight(a.name, 28)) +
        c(Color.DarkGray, `${count} msgs`) +
        unreadStr,
      );
    }
    frame.skipLine();
  }

  terminal.moveTo(frame.currentRow, frame.contentLeft);
  terminal.write(c(Color.LightCyan, 'Select area #') + c(Color.DarkGray, ': ') + c(Color.White, ''));
  const input = await terminal.readLine({ maxLength: 3 });

  if (input) {
    const num = parseInt(input, 10);
    if (num >= 1 && num <= areaList.length) {
      currentAreaTag = areaList[num - 1]!.tag;
    }
  }
}

async function readMessages(session: Session, frame: ScreenFrame): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();
  const area = await messageService.getAreaByTag(currentAreaTag);
  if (!area) return;

  const messages = await messageService.getMessages(area.id, 100);
  if (messages.length === 0) {
    frame.refresh([config.general.bbsName, 'Messages', 'Read'], HOTKEYS_PAUSE);
    frame.skipLine();
    frame.writeContentLine(c(Color.Yellow, 'No messages in this area.'));
    frame.skipLine();
    terminal.moveTo(frame.currentRow, frame.contentLeft);
    await terminal.pause();
    return;
  }

  const reversed = [...messages].reverse();
  let index = 0;

  while (index < reversed.length) {
    const msg = reversed[index]!;

    frame.refresh(
      [config.general.bbsName, 'Messages', area.name, `${index + 1}/${reversed.length}`],
      HOTKEYS_READER,
    );

    // Message header
    frame.writeContentLine(
      c(Color.LightCyan, 'From : ') + c(Color.White, msg.fromName) +
      c(Color.DarkGray, '  To: ') + c(Color.White, msg.toName),
    );
    frame.writeContentLine(
      c(Color.LightCyan, 'Subj : ') + c(Color.White, msg.subject),
    );
    frame.writeContentLine(
      c(Color.LightCyan, 'Date : ') + c(Color.DarkGray, formatDateTime(msg.createdAt)),
    );
    frame.writeContentLine(c(Color.DarkCyan, '─'.repeat(frame.contentWidth)));

    // Body
    const bodyLines = wordWrap(msg.body, frame.contentWidth - 1);
    for (const line of bodyLines) {
      if (frame.remainingRows <= 1) break;
      frame.writeContentLine(c(Color.LightGray, line));
    }

    // Mark as read
    if (session.user) {
      await messageService.markRead(session.user.id, area.id, msg.id);
    }

    // Prompt at bottom of content
    terminal.moveTo(frame.contentBottom, frame.contentLeft);
    terminal.write(
      c(Color.DarkGray, '[') + c(Color.White, 'N') + c(Color.DarkGray, ']ext ') +
      c(Color.DarkGray, '[') + c(Color.White, 'P') + c(Color.DarkGray, ']rev ') +
      c(Color.DarkGray, '[') + c(Color.White, 'R') + c(Color.DarkGray, ']eply ') +
      c(Color.DarkGray, '[') + c(Color.White, 'Q') + c(Color.DarkGray, ']uit '),
    );

    const choice = await terminal.readHotkey(['N', 'P', 'R', 'Q']);
    switch (choice) {
      case 'N': if (index < reversed.length - 1) index++; break;
      case 'P': if (index > 0) index--; break;
      case 'R': await postMessage(session, frame, reversed[index]); break;
      case 'Q': return;
    }
  }
}

async function postMessage(session: Session, frame: ScreenFrame, replyTo?: messageService.Message): Promise<void> {
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
  frame.writeContentLine(c(Color.DarkGray, 'Enter message (two blank lines to finish):'));
  frame.writeContentLine(c(Color.DarkCyan, '─'.repeat(frame.contentWidth)));

  const bodyLines: string[] = [];

  // Quote original
  if (replyTo) {
    const quoteLines = replyTo.body.split('\n').slice(0, 4);
    for (const line of quoteLines) {
      bodyLines.push(`> ${line}`);
      frame.writeContentLine(c(Color.DarkGray, `> ${line}`));
    }
    bodyLines.push('');
    frame.skipLine();
  }

  // Line-by-line input
  let emptyCount = 0;
  while (frame.remainingRows > 2) {
    terminal.moveTo(frame.currentRow, frame.contentLeft);
    terminal.write(c(Color.White, ''));
    const line = await terminal.readLine({ maxLength: frame.contentWidth - 1 });
    frame.setContentRow(frame.currentRow - frame.contentTop + 1);

    if (line === '') {
      emptyCount++;
      if (emptyCount >= 2) break;
      bodyLines.push('');
    } else {
      emptyCount = 0;
      bodyLines.push(line);
    }
  }

  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') {
    bodyLines.pop();
  }

  if (bodyLines.length === 0) {
    frame.writeContentLine(c(Color.LightRed, 'Message aborted (empty body).'));
    terminal.moveTo(frame.currentRow, frame.contentLeft);
    await terminal.pause();
    return;
  }

  terminal.moveTo(frame.currentRow, frame.contentLeft);
  const save = await terminal.promptYesNo(c(Color.LightCyan, 'Save this message?'));

  if (save) {
    await messageService.postMessage(area.id, session.user.id, session.handle, subject, bodyLines.join('\n'), {
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

async function scanMessages(session: Session, frame: ScreenFrame): Promise<void> {
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
    const unread = await messageService.getUnreadCount(a.id, session.user.id);
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

async function lastCallersModule(session: Session, frame: ScreenFrame): Promise<void> {
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

async function oneLinersModule(session: Session, frame: ScreenFrame): Promise<void> {
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
          data: { userId: session.user.id, handle: session.handle, text },
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

async function systemStatsModule(session: Session, frame: ScreenFrame): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();
  const db = getDb();

  frame.refresh([config.general.bbsName, 'System Stats'], HOTKEYS_PAUSE);

  frame.skipLine();
  frame.writeContentLine(c(Color.LightCyan, center('S Y S T E M   S T A T S', frame.contentWidth)));
  frame.skipLine();

  const userCount = await db.user.count();
  const msgCount = await db.message.count();
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
    await auth.logoutUser(session.user.id, session.nodeNumber);
    session.logout();
  }

  session.connection.close();
}
