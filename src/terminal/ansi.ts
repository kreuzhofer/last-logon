// ANSI escape code builder for classic BBS-style terminal output

export const ESC = '\x1b';
export const CSI = `${ESC}[`;

// Classic 16-color BBS palette
export enum Color {
  Black = 0,
  DarkBlue = 1,
  DarkGreen = 2,
  DarkCyan = 3,
  DarkRed = 4,
  DarkMagenta = 5,
  Brown = 6,
  LightGray = 7,
  DarkGray = 8,
  LightBlue = 9,
  LightGreen = 10,
  LightCyan = 11,
  LightRed = 12,
  LightMagenta = 13,
  Yellow = 14,
  White = 15,
}

// Map Color enum to SGR foreground codes
const FG_CODES: Record<number, string> = {
  [Color.Black]: '30',
  [Color.DarkBlue]: '34',
  [Color.DarkGreen]: '32',
  [Color.DarkCyan]: '36',
  [Color.DarkRed]: '31',
  [Color.DarkMagenta]: '35',
  [Color.Brown]: '33',
  [Color.LightGray]: '37',
  [Color.DarkGray]: '1;30',
  [Color.LightBlue]: '1;34',
  [Color.LightGreen]: '1;32',
  [Color.LightCyan]: '1;36',
  [Color.LightRed]: '1;31',
  [Color.LightMagenta]: '1;35',
  [Color.Yellow]: '1;33',
  [Color.White]: '1;37',
};

// Map Color enum to SGR background codes (only 0-7)
const BG_CODES: Record<number, string> = {
  [Color.Black]: '40',
  [Color.DarkBlue]: '44',
  [Color.DarkGreen]: '42',
  [Color.DarkCyan]: '46',
  [Color.DarkRed]: '41',
  [Color.DarkMagenta]: '45',
  [Color.Brown]: '43',
  [Color.LightGray]: '47',
};

export function sgr(...codes: (string | number)[]): string {
  return `${CSI}${codes.join(';')}m`;
}

export function setColor(fg: Color, bg?: Color): string {
  const parts: string[] = ['0']; // Reset first
  const fgCode = FG_CODES[fg];
  if (fgCode) parts.push(fgCode);
  if (bg !== undefined) {
    const bgCode = BG_CODES[bg];
    if (bgCode) parts.push(bgCode);
  }
  return `${CSI}${parts.join(';')}m`;
}

export function resetColor(): string {
  return `${CSI}0m`;
}

export function bold(): string {
  return `${CSI}1m`;
}

export function blink(): string {
  return `${CSI}5m`;
}

// Cursor movement
export function moveTo(row: number, col: number): string {
  return `${CSI}${row};${col}H`;
}

export function moveUp(n = 1): string {
  return `${CSI}${n}A`;
}

export function moveDown(n = 1): string {
  return `${CSI}${n}B`;
}

export function moveRight(n = 1): string {
  return `${CSI}${n}C`;
}

export function moveLeft(n = 1): string {
  return `${CSI}${n}D`;
}

export function saveCursor(): string {
  return `${CSI}s`;
}

export function restoreCursor(): string {
  return `${CSI}u`;
}

// Screen control
export function clearScreen(): string {
  return `${CSI}2J${CSI}1;1H`;
}

export function clearLine(): string {
  return `${CSI}2K`;
}

export function clearToEndOfLine(): string {
  return `${CSI}0K`;
}

export function clearToEndOfScreen(): string {
  return `${CSI}0J`;
}

// Hide/show cursor
export function hideCursor(): string {
  return `${CSI}?25l`;
}

export function showCursor(): string {
  return `${CSI}?25h`;
}

// Box-drawing helpers using Unicode box-drawing characters
export const BoxChars = {
  single: {
    topLeft: '┌',
    topRight: '┐',
    bottomLeft: '└',
    bottomRight: '┘',
    horizontal: '─',
    vertical: '│',
    teeRight: '├',
    teeLeft: '┤',
    teeDown: '┬',
    teeUp: '┴',
    cross: '┼',
  },
  double: {
    topLeft: '╔',
    topRight: '╗',
    bottomLeft: '╚',
    bottomRight: '╝',
    horizontal: '═',
    vertical: '║',
    teeRight: '╠',
    teeLeft: '╣',
    teeDown: '╦',
    teeUp: '╩',
    cross: '╬',
  },
  heavy: {
    topLeft: '┏',
    topRight: '┓',
    bottomLeft: '┗',
    bottomRight: '┛',
    horizontal: '━',
    vertical: '┃',
    teeRight: '┣',
    teeLeft: '┫',
    teeDown: '┳',
    teeUp: '┻',
    cross: '╋',
  },
  block: {
    full: '█',
    dark: '▓',
    medium: '▒',
    light: '░',
    upper: '▀',
    lower: '▄',
    left: '▌',
    right: '▐',
  },
} as const;

export type BoxStyle = keyof typeof BoxChars;
