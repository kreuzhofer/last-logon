// Classic BBS pipe color code parser
// |00-|15 = foreground colors, |16-|23 = background colors
// Maps to ANSI SGR sequences

import { CSI } from '../terminal/ansi.js';

// Pipe code to ANSI SGR mapping
const PIPE_FG: Record<number, string> = {
  0: '0;30',       // Black
  1: '0;34',       // Dark Blue
  2: '0;32',       // Dark Green
  3: '0;36',       // Dark Cyan
  4: '0;31',       // Dark Red
  5: '0;35',       // Dark Magenta
  6: '0;33',       // Brown
  7: '0;37',       // Light Gray
  8: '1;30',       // Dark Gray
  9: '1;34',       // Light Blue
  10: '1;32',      // Light Green
  11: '1;36',      // Light Cyan
  12: '1;31',      // Light Red
  13: '1;35',      // Light Magenta
  14: '1;33',      // Yellow
  15: '1;37',      // White
};

const PIPE_BG: Record<number, string> = {
  16: '40',        // Black BG
  17: '44',        // Blue BG
  18: '42',        // Green BG
  19: '46',        // Cyan BG
  20: '41',        // Red BG
  21: '45',        // Magenta BG
  22: '43',        // Brown/Yellow BG
  23: '47',        // White BG
};

const PIPE_REGEX = /\|(\d{2})/g;

export function parsePipeCodes(text: string): string {
  return text.replace(PIPE_REGEX, (_, code: string) => {
    const num = parseInt(code, 10);
    const fg = PIPE_FG[num];
    if (fg) return `${CSI}${fg}m`;
    const bg = PIPE_BG[num];
    if (bg) return `${CSI}${bg}m`;
    return `|${code}`; // Unknown code, leave as-is
  });
}

export function stripPipeCodes(text: string): string {
  return text.replace(PIPE_REGEX, '');
}

export function pipeCodeLength(text: string): number {
  return stripPipeCodes(text).length;
}
