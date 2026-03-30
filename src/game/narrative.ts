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
  const prefix = sender + ': ';
  const prefixLen = prefix.length;
  const maxWidth = frame.contentWidth;
  const bodyWidth = maxWidth - prefixLen;

  // Strip pipe codes for wrapping, then re-apply
  const cleanText = text.replace(/\|(\d{2})/g, '').replace(/\\n/g, '\n');
  const lines = cleanText.split('\n');

  let firstLine = true;
  for (const line of lines) {
    // Word-wrap each line to fit
    const words = line.split(' ');
    let current = '';

    for (const word of words) {
      const testLen = current.length + (current ? 1 : 0) + word.length;
      const availWidth = firstLine ? bodyWidth : maxWidth - 2;

      if (testLen > availWidth && current) {
        if (firstLine) {
          frame.writeContentLine(
            setColor(senderColor) + prefix + resetColor() + current,
          );
          firstLine = false;
        } else {
          frame.writeContentLine('  ' + resetColor() + current);
        }
        current = word;
        if (frame.remainingRows <= 1) return;
      } else {
        current += (current ? ' ' : '') + word;
      }
    }

    // Flush remaining text
    if (current) {
      if (firstLine) {
        frame.writeContentLine(
          setColor(senderColor) + prefix + resetColor() + current,
        );
        firstLine = false;
      } else {
        frame.writeContentLine('  ' + resetColor() + current);
      }
      if (frame.remainingRows <= 1) return;
    } else if (firstLine) {
      frame.writeContentLine(setColor(senderColor) + prefix + resetColor());
      firstLine = false;
    }
  }
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

// ─── Sound Effects ──────────────────────────────────────────────────────────

/** Terminal bell — used for jump scares and urgent notifications */
export function bell(terminal: Terminal): void {
  terminal.write('\x07');
}

/** Flash the screen briefly (invert colors) for a startle effect */
export async function flashEffect(terminal: Terminal, frame: ScreenFrame): Promise<void> {
  // Invert screen colors briefly
  terminal.write('\x1b[?5h'); // Enable reverse video
  await sleep(100);
  terminal.write('\x1b[?5l'); // Disable reverse video
}

/** Creepy slow reveal — text appears character by character with random delays */
export async function creepyReveal(
  terminal: Terminal,
  frame: ScreenFrame,
  text: string,
  color: Color = Color.LightRed,
): Promise<void> {
  terminal.write(setColor(color));
  for (const char of text) {
    terminal.write(char);
    await sleep(50 + Math.random() * 150); // Random delay 50-200ms
  }
  terminal.write(resetColor());
}

/** Distortion effect — briefly replace screen content with noise */
export async function distortionEffect(terminal: Terminal, frame: ScreenFrame): Promise<void> {
  const noiseChars = '░▒▓█▀▄▌▐│─┤├┼┬┴┐┌┘└';
  const w = frame.contentWidth;

  // Flash noise for a few frames
  for (let f = 0; f < 3; f++) {
    for (let row = frame.contentTop; row <= frame.contentTop + 5; row++) {
      terminal.moveTo(row, frame.contentLeft);
      let noise = '';
      for (let i = 0; i < w; i++) {
        noise += noiseChars[Math.floor(Math.random() * noiseChars.length)]!;
      }
      terminal.write(setColor(Color.DarkGray) + noise + resetColor());
    }
    await sleep(80);
  }
}

// ─── Helper ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export { sleep };
