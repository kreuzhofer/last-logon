// Narrative Renderer — typewriter effects, text display, pipe code integration
// Renders game text through the BBS terminal with atmospheric effects

import { Color, setColor, resetColor } from '../terminal/ansi.js';
import { parsePipeCodes } from '../utils/pipe-codes.js';
import type { Terminal } from '../terminal/terminal.js';
import type { ScreenFrame } from '../terminal/screen-frame.js';

// ─── Typewriter Effect ───────────────────────────────────────────────────────

export async function typewriterLine(
  terminal: Terminal,
  frame: ScreenFrame,
  text: string,
  delayMs: number = 30,
): Promise<void> {
  const parsed = parsePipeCodes(text);
  terminal.moveTo(frame.currentRow, frame.contentLeft);

  // Write character by character for effect
  for (const char of parsed) {
    terminal.write(char);
    if (delayMs > 0 && char !== '\x1b' && !char.startsWith('\x1b')) {
      await sleep(delayMs);
    }
  }
  // Advance frame row
  frame.setContentRow(frame.currentRow - frame.contentTop + 2);
}

export async function typewriterText(
  terminal: Terminal,
  frame: ScreenFrame,
  text: string,
  delayMs: number = 30,
  lineDelayMs: number = 200,
): Promise<void> {
  const lines = text.split('\n');
  for (const line of lines) {
    if (frame.remainingRows <= 1) break;
    if (line.trim() === '') {
      frame.skipLine();
    } else {
      await typewriterLine(terminal, frame, line, delayMs);
    }
    if (lineDelayMs > 0) {
      await sleep(lineDelayMs);
    }
  }
}

// ─── Static Text Display ─────────────────────────────────────────────────────

export function displayText(frame: ScreenFrame, text: string): void {
  const lines = text.split('\n');
  for (const line of lines) {
    if (frame.remainingRows <= 1) break;
    if (line.trim() === '') {
      frame.skipLine();
    } else {
      frame.writeContentLine(parsePipeCodes(line));
    }
  }
}

export function displayScriptedText(
  frame: ScreenFrame,
  text: string,
  language: string,
  textDe?: string,
): void {
  const content = (language === 'de' && textDe) ? textDe : text;
  displayText(frame, content.trim());
}

// ─── Atmospheric Effects ─────────────────────────────────────────────────────

export async function glitchEffect(terminal: Terminal, frame: ScreenFrame): Promise<void> {
  const glitchChars = '░▒▓█▄▀│─┼╪╫';
  const width = frame.contentWidth;

  // Brief screen corruption
  for (let i = 0; i < 3; i++) {
    const row = frame.contentTop + Math.floor(Math.random() * frame.contentHeight);
    terminal.moveTo(row, frame.contentLeft);
    terminal.write(setColor(Color.DarkRed));
    for (let j = 0; j < width; j++) {
      terminal.write(glitchChars[Math.floor(Math.random() * glitchChars.length)]!);
    }
    await sleep(50);
  }
  await sleep(200);
  terminal.write(resetColor());
}

export async function connectionEffect(
  terminal: Terminal,
  frame: ScreenFrame,
  language: string,
): Promise<void> {
  const connecting = language === 'de' ? 'VERBINDUNG WIRD HERGESTELLT' : 'CONNECTING';
  const established = language === 'de' ? 'VERBINDUNG HERGESTELLT' : 'CONNECTION ESTABLISHED';

  frame.writeContentLine(setColor(Color.DarkGray) + `░░░ ${connecting} ░░░` + resetColor());
  await sleep(500);
  frame.writeContentLine(setColor(Color.DarkGray) + '> Terminal handshake... OK' + resetColor());
  await sleep(300);
  frame.writeContentLine(setColor(Color.DarkGray) + '> Verifying credentials...' + resetColor());
  await sleep(400);
  frame.writeContentLine(setColor(Color.LightGreen) + `> ${established}` + resetColor());
  frame.skipLine();
}

export async function disconnectEffect(
  terminal: Terminal,
  frame: ScreenFrame,
  language: string,
): Promise<void> {
  const disconnecting = language === 'de' ? 'VERBINDUNG WIRD GETRENNT' : 'DISCONNECTING';

  await glitchEffect(terminal, frame);
  frame.writeContentLine(setColor(Color.DarkRed) + `░░░ ${disconnecting} ░░░` + resetColor());
  await sleep(800);
}

// ─── Killer Typing Indicator ─────────────────────────────────────────────────

export async function showTypingIndicator(
  terminal: Terminal,
  frame: ScreenFrame,
  killerAlias: string,
  durationMs: number = 1500,
): Promise<void> {
  const row = frame.currentRow;
  const col = frame.contentLeft;

  terminal.moveTo(row, col);
  terminal.write(setColor(Color.DarkGray) + `${killerAlias} is typing` + resetColor());

  const dots = ['', '.', '..', '...'];
  const cycles = Math.ceil(durationMs / 400);
  for (let i = 0; i < cycles; i++) {
    const dot = dots[i % dots.length]!;
    terminal.moveTo(row, col + killerAlias.length + 10);
    terminal.write(setColor(Color.DarkGray) + dot + '   ' + resetColor());
    await sleep(400);
  }

  // Clear the typing indicator
  terminal.moveTo(row, col);
  terminal.write(' '.repeat(frame.contentWidth));
  terminal.moveTo(row, col);
}

// ─── Chat Display ────────────────────────────────────────────────────────────

export function displayChatMessage(
  frame: ScreenFrame,
  sender: string,
  text: string,
  senderColor: Color = Color.LightCyan,
): void {
  frame.writeContentLine(
    setColor(senderColor) + sender + setColor(Color.DarkGray) + ': ' +
    resetColor() + parsePipeCodes(text),
  );
}

export function displaySystemMessage(frame: ScreenFrame, text: string): void {
  frame.writeContentLine(
    setColor(Color.DarkGray) + '[' +
    setColor(Color.Yellow) + 'SYSTEM' +
    setColor(Color.DarkGray) + '] ' +
    resetColor() + parsePipeCodes(text),
  );
}

// ─── Journal / Clue Display ──────────────────────────────────────────────────

export function displayClueEntry(
  frame: ScreenFrame,
  index: number,
  tag: string,
  description: string,
  weight: number,
): void {
  const stars = '★'.repeat(Math.min(weight, 5)) + '☆'.repeat(Math.max(0, 5 - weight));
  frame.writeContentLine(
    setColor(Color.DarkCyan) + `[${String(index).padStart(2, '0')}] ` +
    setColor(Color.LightCyan) + tag +
    setColor(Color.DarkGray) + ` (${stars})`,
  );
  frame.writeContentLine(
    setColor(Color.LightGray) + '     ' + description,
  );
}

// ─── Helper ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export { sleep };
