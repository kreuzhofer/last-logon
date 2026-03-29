// High-level Terminal abstraction
// This is the core interface through which all user interaction flows

import * as ansi from './ansi.js';
import { parseInput, type KeyInput, type SpecialKey } from './input-handler.js';
import { parsePipeCodes } from '../utils/pipe-codes.js';
import type { IConnection } from '../server/connection.js';

export class Terminal {
  private dataBuffer: Buffer[] = [];
  private dataResolve: ((data: Buffer) => void) | null = null;

  constructor(private conn: IConnection) {
    this.conn.onData((data) => {
      if (this.dataResolve) {
        const resolve = this.dataResolve;
        this.dataResolve = null;
        resolve(data);
      } else {
        this.dataBuffer.push(data);
      }
    });
  }

  get screenWidth(): number {
    return this.conn.screenWidth;
  }

  get screenHeight(): number {
    return this.conn.screenHeight;
  }

  // --- Output ---

  write(text: string): void {
    this.conn.write(text);
  }

  writeLine(text: string): void {
    this.conn.write(text + '\r\n');
  }

  writePipe(text: string): void {
    this.conn.write(parsePipeCodes(text));
  }

  writePipeLine(text: string): void {
    this.conn.write(parsePipeCodes(text) + '\r\n');
  }

  // --- Cursor ---

  moveTo(row: number, col: number): void {
    this.write(ansi.moveTo(row, col));
  }

  moveUp(n = 1): void {
    this.write(ansi.moveUp(n));
  }

  moveDown(n = 1): void {
    this.write(ansi.moveDown(n));
  }

  moveRight(n = 1): void {
    this.write(ansi.moveRight(n));
  }

  moveLeft(n = 1): void {
    this.write(ansi.moveLeft(n));
  }

  saveCursor(): void {
    this.write(ansi.saveCursor());
  }

  restoreCursor(): void {
    this.write(ansi.restoreCursor());
  }

  hideCursor(): void {
    this.write(ansi.hideCursor());
  }

  showCursor(): void {
    this.write(ansi.showCursor());
  }

  // --- Screen ---

  clearScreen(): void {
    this.write(ansi.clearScreen());
  }

  clearLine(): void {
    this.write(ansi.clearLine());
  }

  clearToEndOfLine(): void {
    this.write(ansi.clearToEndOfLine());
  }

  // --- Color ---

  setColor(fg: ansi.Color, bg?: ansi.Color): void {
    this.write(ansi.setColor(fg, bg));
  }

  resetColor(): void {
    this.write(ansi.resetColor());
  }

  // --- Drawing ---

  drawBox(
    row: number,
    col: number,
    width: number,
    height: number,
    style: ansi.BoxStyle = 'double',
  ): void {
    const chars = ansi.BoxChars[style];
    if (!('topLeft' in chars)) return; // block style doesn't have box chars

    const box = chars as typeof ansi.BoxChars.double;

    // Top border
    this.moveTo(row, col);
    this.write(box.topLeft + box.horizontal.repeat(width - 2) + box.topRight);

    // Sides
    for (let r = 1; r < height - 1; r++) {
      this.moveTo(row + r, col);
      this.write(box.vertical + ' '.repeat(width - 2) + box.vertical);
    }

    // Bottom border
    this.moveTo(row + height - 1, col);
    this.write(box.bottomLeft + box.horizontal.repeat(width - 2) + box.bottomRight);
  }

  drawHorizontalLine(row: number, col: number, width: number, char = '─'): void {
    this.moveTo(row, col);
    this.write(char.repeat(width));
  }

  // --- Input ---

  private waitForData(): Promise<Buffer> {
    // Check buffer first
    if (this.dataBuffer.length > 0) {
      return Promise.resolve(this.dataBuffer.shift()!);
    }
    return new Promise((resolve) => {
      this.dataResolve = resolve;
    });
  }

  async readKey(): Promise<KeyInput> {
    while (true) {
      const data = await this.waitForData();
      const keys = parseInput(data);
      if (keys.length > 0) return keys[0]!;
    }
  }

  async readHotkey(validKeys: string[]): Promise<string> {
    const upperKeys = validKeys.map((k) => k.toUpperCase());
    while (true) {
      const key = await this.readKey();
      if (key.type === 'char') {
        const upper = key.value.toUpperCase();
        if (upperKeys.includes(upper)) return upper;
      }
      if (key.type === 'special' && upperKeys.includes(key.value)) {
        return key.value;
      }
    }
  }

  async readLine(options?: {
    maxLength?: number;
    mask?: string;
    echo?: boolean;
    defaultValue?: string;
  }): Promise<string> {
    const maxLength = options?.maxLength ?? 255;
    const mask = options?.mask;
    const echo = options?.echo ?? true;
    let buffer = options?.defaultValue ?? '';

    if (echo && buffer.length > 0) {
      this.write(mask ? mask.repeat(buffer.length) : buffer);
    }

    while (true) {
      const key = await this.readKey();

      if (key.type === 'special' && key.value === 'ENTER') {
        this.write('\r\n');
        return buffer;
      }

      if (key.type === 'special' && key.value === 'BACKSPACE') {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          if (echo) this.write('\b \b');
        }
        continue;
      }

      if (key.type === 'ctrl' && key.value === 'C') {
        this.write('\r\n');
        return '';
      }

      if (key.type === 'ctrl' && key.value === 'U') {
        // Clear line
        if (echo) {
          this.write('\b \b'.repeat(buffer.length));
        }
        buffer = '';
        continue;
      }

      if (key.type === 'char' && buffer.length < maxLength) {
        buffer += key.value;
        if (echo) {
          this.write(mask ?? key.value);
        }
      }
    }
  }

  /**
   * Multi-line text editor within a bounded area.
   * Supports: arrow keys across lines, word wrap, backspace across lines, Enter for newline.
   * Finishes on: two consecutive blank Enter presses, or Escape.
   * Returns the text as an array of lines.
   */
  async readTextBlock(options: {
    startRow: number;
    startCol: number;
    width: number;
    maxRows: number;
  }): Promise<string[]> {
    const { startRow, startCol, width, maxRows } = options;
    const lines: string[] = [''];
    let curLine = 0;
    let curCol = 0;
    let consecutiveEmpty = 0;

    const redrawFrom = (fromLine: number) => {
      for (let i = fromLine; i < Math.min(lines.length, maxRows); i++) {
        this.moveTo(startRow + i, startCol);
        this.write(lines[i]!.padEnd(width, ' '));
      }
      // Clear any leftover lines below
      if (lines.length < maxRows) {
        for (let i = lines.length; i < maxRows; i++) {
          this.moveTo(startRow + i, startCol);
          this.write(' '.repeat(width));
        }
      }
      this.moveTo(startRow + curLine, startCol + curCol);
    };

    const placeCursor = () => {
      this.moveTo(startRow + curLine, startCol + curCol);
    };

    // Initial cursor position
    placeCursor();

    while (true) {
      const key = await this.readKey();

      if (key.type === 'special' && key.value === 'ESCAPE') {
        break;
      }

      if (key.type === 'ctrl' && key.value === 'C') {
        return [];
      }

      if (key.type === 'special' && key.value === 'ENTER') {
        const currentLine = lines[curLine] ?? '';
        if (currentLine.length === 0) {
          consecutiveEmpty++;
          if (consecutiveEmpty >= 2) break;
        } else {
          consecutiveEmpty = 0;
        }

        // Split line at cursor
        if (curLine < maxRows - 1) {
          const before = currentLine.slice(0, curCol);
          const after = currentLine.slice(curCol);
          lines[curLine] = before;
          lines.splice(curLine + 1, 0, after);
          // Truncate if exceeding maxRows
          if (lines.length > maxRows) lines.length = maxRows;
          curLine++;
          curCol = 0;
          redrawFrom(curLine - 1);
          placeCursor();
        }
        continue;
      }

      if (key.type === 'special' && key.value === 'BACKSPACE') {
        consecutiveEmpty = 0;
        if (curCol > 0) {
          // Delete char before cursor on current line
          const line = lines[curLine] ?? '';
          lines[curLine] = line.slice(0, curCol - 1) + line.slice(curCol);
          curCol--;
          redrawFrom(curLine);
          placeCursor();
        } else if (curLine > 0) {
          // Join with previous line
          const prevLine = lines[curLine - 1] ?? '';
          const thisLine = lines[curLine] ?? '';
          if (prevLine.length + thisLine.length <= width) {
            curCol = prevLine.length;
            lines[curLine - 1] = prevLine + thisLine;
            lines.splice(curLine, 1);
            curLine--;
            redrawFrom(curLine);
            placeCursor();
          }
        }
        continue;
      }

      if (key.type === 'special' && key.value === 'LEFT') {
        if (curCol > 0) {
          curCol--;
        } else if (curLine > 0) {
          curLine--;
          curCol = (lines[curLine] ?? '').length;
        }
        placeCursor();
        continue;
      }

      if (key.type === 'special' && key.value === 'RIGHT') {
        const lineLen = (lines[curLine] ?? '').length;
        if (curCol < lineLen) {
          curCol++;
        } else if (curLine < lines.length - 1) {
          curLine++;
          curCol = 0;
        }
        placeCursor();
        continue;
      }

      if (key.type === 'special' && key.value === 'UP') {
        if (curLine > 0) {
          curLine--;
          curCol = Math.min(curCol, (lines[curLine] ?? '').length);
          placeCursor();
        }
        continue;
      }

      if (key.type === 'special' && key.value === 'DOWN') {
        if (curLine < lines.length - 1) {
          curLine++;
          curCol = Math.min(curCol, (lines[curLine] ?? '').length);
          placeCursor();
        }
        continue;
      }

      if (key.type === 'special' && key.value === 'HOME') {
        curCol = 0;
        placeCursor();
        continue;
      }

      if (key.type === 'special' && key.value === 'END') {
        curCol = (lines[curLine] ?? '').length;
        placeCursor();
        continue;
      }

      // Regular character input
      if (key.type === 'char') {
        consecutiveEmpty = 0;
        const line = lines[curLine] ?? '';

        if (line.length < width) {
          // Insert character at cursor
          lines[curLine] = line.slice(0, curCol) + key.value + line.slice(curCol);
          curCol++;

          // Check if line now exceeds width — word wrap
          if ((lines[curLine] ?? '').length > width) {
            const fullLine = lines[curLine]!;
            // Find last space to wrap at
            let wrapAt = fullLine.lastIndexOf(' ', width);
            if (wrapAt <= 0) wrapAt = width;

            const keep = fullLine.slice(0, wrapAt);
            const overflow = fullLine.slice(wrapAt).trimStart();

            lines[curLine] = keep;

            if (curLine < maxRows - 1) {
              // Push overflow to next line
              const nextLine = lines[curLine + 1] ?? '';
              if (nextLine.length === 0 || lines.length <= curLine + 1) {
                lines.splice(curLine + 1, 0, overflow);
              } else {
                lines[curLine + 1] = overflow + (nextLine ? ' ' + nextLine : '');
              }
              if (lines.length > maxRows) lines.length = maxRows;

              // Move cursor to overflow position
              if (curCol > keep.length) {
                curCol = curCol - wrapAt - (fullLine[wrapAt] === ' ' ? 1 : 0);
                curLine++;
              }
            }

            redrawFrom(curLine > 0 ? curLine - 1 : 0);
          } else {
            // Just redraw current line
            this.moveTo(startRow + curLine, startCol);
            this.write(lines[curLine]!.padEnd(width, ' '));
          }
          placeCursor();
        }
        continue;
      }
    }

    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines;
  }

  async pause(prompt?: string): Promise<void> {
    this.writePipe(prompt ?? '|08[|15Press any key to continue|08]');
    await this.readKey();
    this.write('\r\n');
  }

  async promptYesNo(prompt: string, defaultYes = true): Promise<boolean> {
    const hint = defaultYes ? '[Y/n]' : '[y/N]';
    this.writePipe(`${prompt} |08${hint} `);
    const key = await this.readKey();
    this.write('\r\n');

    if (key.type === 'special' && key.value === 'ENTER') return defaultYes;
    if (key.type === 'char') {
      const c = key.value.toUpperCase();
      if (c === 'Y') return true;
      if (c === 'N') return false;
    }
    return defaultYes;
  }

  async morePrompt(): Promise<boolean> {
    this.writePipe('|08[|15More|08: |11Y|08/|11N|08/|11C|08] ');
    const key = await this.readHotkey(['Y', 'N', 'C', 'ENTER']);
    this.write('\r');
    this.clearLine();
    return key !== 'N';
  }

  // Paginated output - displays lines with "more" prompt every screenHeight-1 lines
  async paginatedOutput(lines: string[], startLine = 0): Promise<void> {
    const pageSize = this.screenHeight - 2;
    let lineNum = startLine;

    while (lineNum < lines.length) {
      const end = Math.min(lineNum + pageSize, lines.length);
      for (let i = lineNum; i < end; i++) {
        this.writeLine(lines[i]!);
      }
      lineNum = end;

      if (lineNum < lines.length) {
        const cont = await this.morePrompt();
        if (!cont) break;
      }
    }
  }
}
