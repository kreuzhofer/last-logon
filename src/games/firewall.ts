// Hack the Firewall — Reaction-time packet capture game
// Data packets scroll across the screen; player presses Space/Enter to capture them.
// Encrypted packets (shown as ???) reveal partial clues when captured.

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

// ─── Encrypted message fragments per chapter ────────────────────────────────

const ENCRYPTED_FRAGMENTS: Record<number, string[]> = {
  0: [
    'THE', 'SYSTEM', 'IS', 'NOT', 'WHAT', 'IT', 'SEEMS',
    'WATCH', 'THE', 'LOGS',
  ],
  1: [
    'USERS', 'ARE', 'VANISHING', 'CHECK', 'THE', 'CALLER',
    'LOG', 'FOR', 'MISSING', 'NAMES',
  ],
  2: [
    'HIDDEN', 'TERMINAL', 'ACCESS', 'BELOW', 'THE', 'MAIN',
    'SYSTEM', 'REQUIRES', 'LEVEL', '255',
  ],
  3: [
    'SERVER', 'ORIGIN', 'TRACED', 'TO', 'LOCAL', 'NETWORK',
    'PROXY', 'CHAIN', 'BROKEN', 'FOUND',
  ],
  4: [
    'ALL', 'EVIDENCE', 'POINTS', 'TO', 'AXIOM', 'THE',
    'SYSOP', 'IS', 'THE', 'KILLER',
  ],
};

const ASSEMBLED_MESSAGES: Record<number, string> = {
  0: 'THE SYSTEM IS NOT WHAT IT SEEMS. WATCH THE LOGS.',
  1: 'USERS ARE VANISHING. CHECK THE CALLER LOG FOR MISSING NAMES.',
  2: 'HIDDEN TERMINAL ACCESS BELOW THE MAIN SYSTEM REQUIRES LEVEL 255.',
  3: 'SERVER ORIGIN TRACED TO LOCAL NETWORK. PROXY CHAIN BROKEN. FOUND.',
  4: 'ALL EVIDENCE POINTS TO AXIOM. THE SYSOP IS THE KILLER.',
};

const CLUE_REWARDS: Record<number, string | undefined> = {
  0: undefined,
  1: 'news_disappearances',
  2: 'hidden_system_access',
  3: 'server_location',
  4: 'killer_identity',
};

// ─── Packet types ───────────────────────────────────────────────────────────

interface Packet {
  row: number;
  col: number;        // Current column position
  speed: number;      // Columns per tick
  char: string;       // Display character
  encrypted: boolean; // If true, shows as ??? until captured
  fragmentIdx: number; // Index into fragments array (-1 if not encrypted)
  color: Color;
  active: boolean;
  tickAccum: number;
}

// ─── State ──────────────────────────────────────────────────────────────────

interface FirewallState {
  highScore: number;
  totalCaptures: number;
  messagesAssembled: number;
  fragmentsCaptured: Record<number, string[]>; // chapter -> captured fragments
}

// ─── ASCII art for regular packets ──────────────────────────────────────────

const PACKET_CHARS = ['<>', '[]', '{}', '()', '<#>', '[*]', '{!}', '(@)'];
const PACKET_COLORS: Color[] = [
  Color.LightCyan, Color.LightGreen, Color.LightBlue,
  Color.LightMagenta, Color.Yellow, Color.White,
];

// ─── Main game ──────────────────────────────────────────────────────────────

export async function hackFirewall(
  session: Session,
  frame: ScreenFrame,
  game: PlayerGame,
): Promise<GameResult> {
  const terminal = session.terminal;
  const chapter = getChapterNumber(game.chapter);
  const userId = game.userId;

  // Load state
  let state = await loadGameState<FirewallState>('firewall', userId);
  if (!state) {
    state = { highScore: 0, totalCaptures: 0, messagesAssembled: 0, fragmentsCaptured: {} };
  }

  const chapterKey = Math.min(chapter, 4);
  const fragments = ENCRYPTED_FRAGMENTS[chapterKey] ?? ENCRYPTED_FRAGMENTS[0]!;
  if (!state.fragmentsCaptured[chapterKey]) {
    state.fragmentsCaptured[chapterKey] = [];
  }
  const capturedFragments = state.fragmentsCaptured[chapterKey]!;

  // Setup screen
  frame.refresh(['Games', 'Hack the Firewall'], [
    { key: 'SPACE', label: 'Capture' },
    { key: 'ESC', label: 'Exit' },
  ]);
  frame.clearContent();

  const TOP = frame.contentTop;
  const LEFT = frame.contentLeft;
  const WIDTH = frame.contentWidth;
  const HEIGHT = frame.contentHeight;

  // Play area: rows TOP to TOP+PLAY_HEIGHT
  const PLAY_HEIGHT = HEIGHT - 5;
  const TARGET_COL = Math.floor(WIDTH / 2); // Target zone column

  // Draw target zone
  drawTargetZone(terminal, TOP, LEFT, TARGET_COL, PLAY_HEIGHT);

  // Status area
  const STATUS_ROW = TOP + PLAY_HEIGHT + 1;

  // Game state
  const packets: Packet[] = [];
  let score = 0;
  let encryptedCaptures = 0;
  let totalCaptures = 0;
  let missedPackets = 0;
  let maxMisses = 15;
  let tick = 0;
  let spawnRate = 25; // Ticks between spawns
  let speedMultiplier = 1.0;
  let running = true;
  let newFragmentsCaptured: string[] = [];

  terminal.hideCursor();

  // Initial status
  drawFirewallStatus(terminal, STATUS_ROW, LEFT, WIDTH, score, encryptedCaptures, fragments.length, missedPackets, maxMisses);

  while (running) {
    tick++;

    // Increase difficulty over time
    if (tick % 200 === 0) {
      speedMultiplier += 0.1;
      if (spawnRate > 10) spawnRate--;
    }

    // Spawn new packets
    if (tick % spawnRate === 0) {
      const isEncrypted = Math.random() < 0.25; // 25% chance of encrypted packet
      const row = TOP + 1 + Math.floor(Math.random() * (PLAY_HEIGHT - 2));
      let fragmentIdx = -1;

      if (isEncrypted) {
        // Pick an uncaptured fragment
        const uncaptured = fragments
          .map((f, i) => ({ f, i }))
          .filter(({ f }) => !capturedFragments.includes(f) && !newFragmentsCaptured.includes(f));
        if (uncaptured.length > 0) {
          const pick = uncaptured[Math.floor(Math.random() * uncaptured.length)]!;
          fragmentIdx = pick.i;
        }
      }

      const packet: Packet = {
        row,
        col: 0,
        speed: (0.4 + Math.random() * 0.6) * speedMultiplier,
        char: isEncrypted && fragmentIdx >= 0
          ? '???'
          : PACKET_CHARS[Math.floor(Math.random() * PACKET_CHARS.length)]!,
        encrypted: isEncrypted && fragmentIdx >= 0,
        fragmentIdx,
        color: isEncrypted && fragmentIdx >= 0
          ? Color.LightRed
          : PACKET_COLORS[Math.floor(Math.random() * PACKET_COLORS.length)]!,
        active: true,
        tickAccum: 0,
      };
      packets.push(packet);
    }

    // Update packets
    for (const packet of packets) {
      if (!packet.active) continue;

      packet.tickAccum += packet.speed;
      if (packet.tickAccum < 1) continue;
      packet.tickAccum -= 1;

      // Erase old position
      const oldCol = LEFT + packet.col;
      if (packet.col >= 0 && packet.col < WIDTH) {
        terminal.moveTo(packet.row, oldCol);
        // Redraw target zone pipe if overlapping
        if (packet.col === TARGET_COL || packet.col === TARGET_COL - 1 || packet.col === TARGET_COL + 1) {
          terminal.write(setColor(Color.DarkCyan) + '|' + resetColor());
        } else {
          terminal.write(' ');
        }
        // Also clear the packet width
        for (let c = 1; c < packet.char.length; c++) {
          if (packet.col + c < WIDTH) {
            terminal.moveTo(packet.row, oldCol + c);
            const relCol = packet.col + c;
            if (relCol === TARGET_COL || relCol === TARGET_COL - 1 || relCol === TARGET_COL + 1) {
              terminal.write(setColor(Color.DarkCyan) + '|' + resetColor());
            } else {
              terminal.write(' ');
            }
          }
        }
      }

      packet.col++;

      // Draw new position
      if (packet.col >= 0 && packet.col < WIDTH - packet.char.length) {
        terminal.moveTo(packet.row, LEFT + packet.col);
        terminal.write(setColor(packet.color) + packet.char + resetColor());
      }

      // Packet left the screen
      if (packet.col >= WIDTH) {
        packet.active = false;
        missedPackets++;
        if (missedPackets >= maxMisses) {
          running = false;
        }
      }
    }

    // Clean up inactive packets
    if (tick % 50 === 0) {
      const activeOnly = packets.filter(p => p.active);
      packets.length = 0;
      packets.push(...activeOnly);
    }

    // Update status
    if (tick % 5 === 0) {
      drawFirewallStatus(terminal, STATUS_ROW, LEFT, WIDTH, score, encryptedCaptures, fragments.length, missedPackets, maxMisses);
    }

    // Check for input
    const key = await readKeyWithTimeout(session, 50);

    if (key) {
      if (key.type === 'special' && key.value === 'ESCAPE') {
        running = false;
        break;
      }

      if (
        (key.type === 'char' && key.value === ' ') ||
        (key.type === 'special' && key.value === 'ENTER')
      ) {
        // Try to capture a packet in the target zone
        let captured = false;
        for (const packet of packets) {
          if (!packet.active) continue;
          // Check if packet overlaps the target zone (3-col wide)
          const packetEnd = packet.col + packet.char.length;
          if (packet.col <= TARGET_COL + 1 && packetEnd >= TARGET_COL - 1) {
            // Captured!
            captured = true;
            packet.active = false;
            totalCaptures++;
            score += packet.encrypted ? 50 : 10;

            // Flash capture effect
            terminal.moveTo(packet.row, LEFT + Math.max(0, packet.col));
            terminal.write(setColor(Color.White, Color.DarkGreen) + ' HIT ' + resetColor());

            if (packet.encrypted && packet.fragmentIdx >= 0) {
              encryptedCaptures++;
              const fragment = fragments[packet.fragmentIdx]!;
              if (!capturedFragments.includes(fragment) && !newFragmentsCaptured.includes(fragment)) {
                newFragmentsCaptured.push(fragment);

                // Show captured fragment
                terminal.moveTo(STATUS_ROW + 2, LEFT);
                terminal.write(
                  setColor(Color.Yellow) + '  DECRYPTED: ' +
                  setColor(Color.White) + fragment +
                  ' '.repeat(Math.max(0, WIDTH - fragment.length - 15)) +
                  resetColor(),
                );
              }
            }

            // Clear the hit marker after brief delay
            setTimeout(() => {
              try {
                terminal.moveTo(packet.row, LEFT + Math.max(0, packet.col));
                terminal.write('     ');
              } catch { /* connection may be closed */ }
            }, 200);

            break; // Only capture one per press
          }
        }

        if (!captured) {
          // Miss flash
          terminal.moveTo(STATUS_ROW + 2, LEFT);
          terminal.write(
            setColor(Color.LightRed) + '  MISS!' +
            ' '.repeat(Math.max(0, WIDTH - 9)) +
            resetColor(),
          );
        }
      }
    }
  }

  terminal.showCursor();

  // Add newly captured fragments to state
  for (const f of newFragmentsCaptured) {
    if (!capturedFragments.includes(f)) {
      capturedFragments.push(f);
    }
  }

  // Check if full message assembled
  let resultSecret: string | undefined;
  let resultClue: string | undefined;

  const allCaptured = fragments.every(f => capturedFragments.includes(f));
  if (allCaptured && state.messagesAssembled === 0) {
    state.messagesAssembled++;
    resultSecret = ASSEMBLED_MESSAGES[chapterKey] ?? ASSEMBLED_MESSAGES[0];
    resultClue = CLUE_REWARDS[chapterKey];
  } else if (newFragmentsCaptured.length > 0) {
    resultSecret = `Firewall fragments captured: ${newFragmentsCaptured.join(' ')} (${capturedFragments.length}/${fragments.length})`;
  }

  if (score > state.highScore) {
    state.highScore = score;
  }
  state.totalCaptures += totalCaptures;

  // Game over screen
  frame.clearContent();
  frame.setBreadcrumb('Games', 'Hack the Firewall', 'Results');
  frame.skipLine();
  frame.writeContentLine(setColor(Color.LightCyan) + '  FIREWALL BREACH REPORT' + resetColor());
  frame.skipLine();
  frame.writeContentLine(
    setColor(Color.DarkGray) + '  Packets captured: ' +
    setColor(Color.White) + String(totalCaptures) + resetColor(),
  );
  frame.writeContentLine(
    setColor(Color.DarkGray) + '  Encrypted found:  ' +
    setColor(Color.Yellow) + String(encryptedCaptures) + resetColor(),
  );
  frame.writeContentLine(
    setColor(Color.DarkGray) + '  Score:            ' +
    setColor(Color.White) + String(score) + resetColor(),
  );
  frame.writeContentLine(
    setColor(Color.DarkGray) + '  High score:       ' +
    setColor(Color.Yellow) + String(state.highScore) + resetColor(),
  );
  frame.skipLine();

  // Show fragments progress
  frame.writeContentLine(
    setColor(Color.DarkGray) + '  Message fragments: ' +
    setColor(Color.LightCyan) + `${capturedFragments.length}/${fragments.length}` +
    resetColor(),
  );

  if (capturedFragments.length > 0) {
    // Show assembled fragments
    frame.writeContentLine(
      setColor(Color.DarkGray) + '  Decoded: ' +
      setColor(Color.LightGreen) + capturedFragments.join(' ') +
      (allCaptured ? '' : ' ...') +
      resetColor(),
    );
  }

  if (allCaptured) {
    frame.skipLine();
    frame.writeContentLine(setColor(Color.Yellow) + '  === FULL MESSAGE DECODED ===' + resetColor());
    frame.writeContentLine(
      setColor(Color.LightGreen) + '  ' + (ASSEMBLED_MESSAGES[chapterKey] ?? '') + resetColor(),
    );
  }

  frame.skipLine();
  frame.writeContentLine(setColor(Color.DarkGray) + '  Press any key...' + resetColor());
  await terminal.readKey();

  // Save
  await saveGameState('firewall', userId, state);
  if (score > 0) {
    await saveHighScore('firewall', userId, session.handle, score);
  }

  return { secretFound: resultSecret, clueRevealed: resultClue };
}

// ─── Drawing helpers ────────────────────────────────────────────────────────

function drawTargetZone(
  terminal: import('../terminal/terminal.js').Terminal,
  top: number,
  left: number,
  targetCol: number,
  height: number,
): void {
  // Draw vertical target lines
  for (let r = 0; r < height; r++) {
    terminal.moveTo(top + r, left + targetCol - 1);
    terminal.write(setColor(Color.DarkCyan) + '|' + resetColor());
    terminal.moveTo(top + r, left + targetCol + 1);
    terminal.write(setColor(Color.DarkCyan) + '|' + resetColor());
  }

  // Label
  terminal.moveTo(top, left + targetCol - 4);
  terminal.write(setColor(Color.LightCyan) + '[CAPTURE]' + resetColor());
}

function drawFirewallStatus(
  terminal: import('../terminal/terminal.js').Terminal,
  statusRow: number,
  left: number,
  width: number,
  score: number,
  encCaps: number,
  totalFrags: number,
  missed: number,
  maxMisses: number,
): void {
  terminal.moveTo(statusRow, left);
  terminal.write(setColor(Color.DarkGreen) + '-'.repeat(width) + resetColor());

  terminal.moveTo(statusRow + 1, left);
  terminal.write(
    setColor(Color.DarkGray) + '  Score: ' +
    setColor(Color.White) + String(score).padStart(5) +
    setColor(Color.DarkGray) + '  |  Encrypted: ' +
    setColor(Color.Yellow) + `${encCaps}/${totalFrags}` +
    setColor(Color.DarkGray) + '  |  Missed: ' +
    (missed >= maxMisses - 3 ? setColor(Color.LightRed) : setColor(Color.LightGray)) +
    `${missed}/${maxMisses}` +
    ' '.repeat(Math.max(0, width - 60)) +
    resetColor(),
  );
}
