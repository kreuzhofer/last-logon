// ScreenFrame - persistent border, breadcrumb, and hotkey bar around ALL screens
//
// Layout on 80x25:
//   Row 1:  ╔══ BBS > Main Menu ══════════════════════════════════════════════════╗
//   Row 2:  ║                                                                    ║
//   ...     ║  (content area: rows 2-24, cols 3-78 = 76 chars wide, 23 rows)    ║
//   Row 24: ║                                                                    ║
//   Row 25: ╚══ [M]sgs [F]iles [W]ho [G]oodbye ═════════════════════════════════╝

import * as ansi from './ansi.js';
import { Color } from './ansi.js';
import { Terminal } from './terminal.js';
import { parsePipeCodes } from '../utils/pipe-codes.js';
import { stripAnsi } from '../utils/string-utils.js';

const D = ansi.BoxChars.double;

// Colors for the frame chrome
const BORDER_COLOR = Color.DarkCyan;
const BREADCRUMB_COLOR = Color.LightCyan;
const BREADCRUMB_SEP_COLOR = Color.DarkGray;
const HOTKEY_BRACKET_COLOR = Color.DarkGray;
const HOTKEY_KEY_COLOR = Color.White;
const HOTKEY_LABEL_COLOR = Color.LightGray;

export interface HotkeyDef {
  key: string;   // The letter, e.g. 'M'
  label: string; // The label, e.g. 'Messages'
}

export class ScreenFrame {
  // Content area dimensions (inside the border)
  readonly contentTop = 2;
  readonly contentLeft = 3;
  readonly contentWidth: number;
  readonly contentHeight: number;
  readonly contentBottom: number;
  readonly contentRight: number;

  private breadcrumb: string[] = [];
  private hotkeys: HotkeyDef[] = [];
  private cursorRow: number;
  private _hasNewMail = false;
  private mailAnimFrame = 0;
  private mailAnimTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly MAIL_ANIM = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  constructor(private terminal: Terminal) {
    // Fixed 80x25 layout — classic BBS ANSI art requires exact dimensions
    const w = 80;
    const h = 25;
    // Accommodate the border: 1 char each side + 1 space padding
    this.contentWidth = w - 4; // cols 3 to 78 = 76 chars wide
    this.contentHeight = h - 2; // rows 2 to 24 = 23 rows tall
    this.contentBottom = h - 1;
    this.contentRight = w - 2;
    this.cursorRow = this.contentTop;
  }

  /** Fixed screen width — 80 columns for ANSI art compatibility */
  private get screenW(): number {
    return 80;
  }

  /** Fixed screen height — 25 rows for ANSI art compatibility */
  private get screenH(): number {
    return 25;
  }

  // --- Frame Drawing ---

  /** Draw the full frame border, clearing the screen first */
  drawFrame(): void {
    const w = this.screenW;
    const h = this.screenH;
    const t = this.terminal;

    t.clearScreen();
    t.hideCursor();

    // Draw all side borders first (rows 2 through h-1)
    t.setColor(BORDER_COLOR);
    for (let row = 2; row < h; row++) {
      t.moveTo(row, 1);
      t.write(D.vertical);
      t.moveTo(row, w);
      t.write(D.vertical);
    }

    // Top and bottom borders drawn by updateBreadcrumb/updateHotkeys
    this.drawTopBorder();
    this.drawBottomBorder();

    t.resetColor();
    t.showCursor();

    // Reset content cursor
    this.cursorRow = this.contentTop;
  }

  /** Redraw just the top border row with current breadcrumb */
  private drawTopBorder(): void {
    const w = this.screenW;
    const t = this.terminal;

    t.moveTo(1, 1);
    t.setColor(BORDER_COLOR);
    t.write(D.topLeft + D.horizontal);

    // Breadcrumb text
    const crumbText = this.formatBreadcrumb();
    const crumbVisible = stripAnsi(crumbText);
    t.write(' ');
    t.write(crumbText);
    t.write(' ');
    t.setColor(BORDER_COLOR);

    // Mail indicator on the right side: " * MAIL " = 8 visible chars
    const mailTagLen = this._hasNewMail ? 8 : 0;

    // Fill remaining with horizontal border
    const used = 3 + crumbVisible.length + 1; // ╔═ + space + crumb + space
    const remaining = w - used - 1 - mailTagLen; // -1 for ╗, minus mail indicator
    if (remaining > 0) {
      t.write(D.horizontal.repeat(remaining));
    }

    // Draw mail indicator with animated character
    if (this._hasNewMail) {
      const animChar = ScreenFrame.MAIL_ANIM[this.mailAnimFrame] ?? '⠋';
      t.write(ansi.setColor(Color.Yellow) + ' ' + animChar + ansi.setColor(Color.White) + ' MAIL ');
      t.setColor(BORDER_COLOR);
    }

    t.write(D.topRight);
  }

  /** Redraw just the bottom border row with current hotkeys */
  private drawBottomBorder(): void {
    const w = this.screenW;
    const h = this.screenH;
    const t = this.terminal;

    t.moveTo(h, 1);
    t.setColor(BORDER_COLOR);
    t.write(D.bottomLeft + D.horizontal);

    // Hotkey text
    const hotkeyText = this.formatHotkeys();
    const hotkeyVisible = stripAnsi(hotkeyText);

    if (hotkeyVisible.length > 0) {
      t.write(' ');
      t.write(hotkeyText);
      t.write(' ');
      t.setColor(BORDER_COLOR);
      const used = 3 + hotkeyVisible.length + 1;
      const remaining = w - used - 1;
      if (remaining > 0) {
        t.write(D.horizontal.repeat(remaining));
      }
    } else {
      const remaining = w - 3; // ╚═ ... ╝
      t.write(D.horizontal.repeat(remaining));
    }

    t.write(D.bottomRight);
  }

  /** Format the breadcrumb with colors */
  private formatBreadcrumb(): string {
    if (this.breadcrumb.length === 0) return '';

    return this.breadcrumb
      .map((part, i) => {
        const color = ansi.setColor(BREADCRUMB_COLOR);
        if (i < this.breadcrumb.length - 1) {
          return color + part + ansi.setColor(BREADCRUMB_SEP_COLOR) + ' > ';
        }
        return color + part;
      })
      .join('');
  }

  /** Format hotkeys for the bottom bar */
  private formatHotkeys(): string {
    if (this.hotkeys.length === 0) return '';

    return this.hotkeys
      .map((hk) => {
        return (
          ansi.setColor(HOTKEY_BRACKET_COLOR) + '[' +
          ansi.setColor(HOTKEY_KEY_COLOR) + hk.key +
          ansi.setColor(HOTKEY_BRACKET_COLOR) + ']' +
          ansi.setColor(HOTKEY_LABEL_COLOR) + hk.label
        );
      })
      .join(ansi.setColor(BORDER_COLOR) + ' ' + D.horizontal + ' ');
  }

  // --- Public API ---

  /** Set the breadcrumb path and redraw the top border */
  setBreadcrumb(...parts: string[]): void {
    this.breadcrumb = parts;
    this.drawTopBorder();
  }

  /** Set the hotkeys and redraw the bottom border */
  setHotkeys(hotkeys: HotkeyDef[]): void {
    this.hotkeys = hotkeys;
    this.drawBottomBorder();
  }

  /** Clear only the content area (preserves frame) */
  clearContent(): void {
    const t = this.terminal;
    const innerWidth = this.contentWidth;

    for (let row = this.contentTop; row <= this.contentBottom; row++) {
      t.moveTo(row, this.contentLeft);
      t.write(' '.repeat(innerWidth));
    }

    this.cursorRow = this.contentTop;
    t.moveTo(this.contentTop, this.contentLeft);
  }

  /** Write a line of text in the content area, auto-advancing the cursor row */
  writeContent(text: string): void {
    if (this.cursorRow > this.contentBottom) return;
    const t = this.terminal;
    t.moveTo(this.cursorRow, this.contentLeft);
    t.write(text);
  }

  /** Write a line and advance to next row */
  writeContentLine(text: string): void {
    this.writeContent(text);
    this.cursorRow++;
  }

  /** Write with pipe codes and advance */
  writeContentPipeLine(text: string): void {
    this.writeContentLine(parsePipeCodes(text));
  }

  /** Skip a line (blank row) */
  skipLine(): void {
    this.cursorRow++;
  }

  /** Get current content row (for manual positioning) */
  get currentRow(): number {
    return this.cursorRow;
  }

  /** Set the content cursor to a specific row within the content area */
  setContentRow(row: number): void {
    this.cursorRow = this.contentTop + row;
  }

  /** Move terminal cursor to a specific position in content area */
  moveToCont(row: number, col: number): void {
    this.terminal.moveTo(this.contentTop + row, this.contentLeft + col);
  }

  /** How many content rows are available from current position */
  get remainingRows(): number {
    return Math.max(0, this.contentBottom - this.cursorRow + 1);
  }

  /** Total content rows available */
  get totalRows(): number {
    return this.contentHeight;
  }

  /** Full screen refresh: redraw frame + set breadcrumb + hotkeys + clear content */
  refresh(breadcrumb: string[], hotkeys: HotkeyDef[]): void {
    this.breadcrumb = breadcrumb;
    this.hotkeys = hotkeys;
    this.drawFrame();
  }

  /** Set the new mail indicator (animated in the top border) */
  set hasNewMail(value: boolean) {
    if (this._hasNewMail !== value) {
      this._hasNewMail = value;
      if (value) {
        this.startMailAnimation();
      } else {
        this.stopMailAnimation();
      }
      this.drawTopBorder();
    }
  }

  get hasNewMail(): boolean {
    return this._hasNewMail;
  }

  private startMailAnimation(): void {
    if (this.mailAnimTimer) return;
    this.mailAnimFrame = 0;
    this.mailAnimTimer = setInterval(() => {
      this.mailAnimFrame = (this.mailAnimFrame + 1) % ScreenFrame.MAIL_ANIM.length;
      this.drawMailIndicator();
    }, 120);
  }

  private stopMailAnimation(): void {
    if (this.mailAnimTimer) {
      clearInterval(this.mailAnimTimer);
      this.mailAnimTimer = null;
    }
  }

  /** Redraw just the animated mail indicator character without redrawing the whole border */
  private drawMailIndicator(): void {
    if (!this._hasNewMail) return;
    const t = this.terminal;
    const w = this.screenW;
    // " * MAIL " — the animated char is at col w-7 (8 chars from right edge: space+char+space+MAIL+space+╗)
    const animChar = ScreenFrame.MAIL_ANIM[this.mailAnimFrame] ?? '⠋';

    // Save cursor, draw only the animated character, restore cursor
    t.saveCursor();
    t.moveTo(1, w - 7);
    t.write(ansi.setColor(Color.Yellow) + animChar + ansi.resetColor());
    t.restoreCursor();
  }

  /** Clean up timer on session end */
  destroy(): void {
    this.stopMailAnimation();
  }
}

