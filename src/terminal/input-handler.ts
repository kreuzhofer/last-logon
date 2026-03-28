// Keyboard input parser for terminal escape sequences

export type KeyInput =
  | { type: 'char'; value: string }
  | { type: 'special'; value: SpecialKey }
  | { type: 'ctrl'; value: string };

export type SpecialKey =
  | 'UP'
  | 'DOWN'
  | 'LEFT'
  | 'RIGHT'
  | 'HOME'
  | 'END'
  | 'INSERT'
  | 'DELETE'
  | 'PAGEUP'
  | 'PAGEDOWN'
  | 'ENTER'
  | 'BACKSPACE'
  | 'TAB'
  | 'ESCAPE'
  | 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6'
  | 'F7' | 'F8' | 'F9' | 'F10' | 'F11' | 'F12';

// Escape sequence to special key mapping
const ESC_SEQUENCES: Record<string, SpecialKey> = {
  '[A': 'UP',
  '[B': 'DOWN',
  '[C': 'RIGHT',
  '[D': 'LEFT',
  '[H': 'HOME',
  '[F': 'END',
  '[1~': 'HOME',
  '[2~': 'INSERT',
  '[3~': 'DELETE',
  '[4~': 'END',
  '[5~': 'PAGEUP',
  '[6~': 'PAGEDOWN',
  'OP': 'F1',
  'OQ': 'F2',
  'OR': 'F3',
  'OS': 'F4',
  '[15~': 'F5',
  '[17~': 'F6',
  '[18~': 'F7',
  '[19~': 'F8',
  '[20~': 'F9',
  '[21~': 'F10',
  '[23~': 'F11',
  '[24~': 'F12',
};

export function parseInput(data: Buffer): KeyInput[] {
  const keys: KeyInput[] = [];
  let i = 0;

  while (i < data.length) {
    const byte = data[i]!;

    // ESC sequence
    if (byte === 0x1b) {
      // Try to match an escape sequence
      const remaining = data.subarray(i + 1).toString('utf-8');
      let matched = false;

      for (const [seq, key] of Object.entries(ESC_SEQUENCES)) {
        if (remaining.startsWith(seq)) {
          keys.push({ type: 'special', value: key });
          i += 1 + Buffer.byteLength(seq, 'utf-8');
          matched = true;
          break;
        }
      }

      if (!matched) {
        if (remaining.length === 0) {
          // Bare ESC
          keys.push({ type: 'special', value: 'ESCAPE' });
          i += 1;
        } else {
          // Unknown escape sequence, skip ESC
          keys.push({ type: 'special', value: 'ESCAPE' });
          i += 1;
        }
      }
      continue;
    }

    // Enter (CR or LF)
    if (byte === 0x0d) {
      keys.push({ type: 'special', value: 'ENTER' });
      // Skip LF if it follows CR
      if (i + 1 < data.length && data[i + 1] === 0x0a) i++;
      i++;
      continue;
    }
    if (byte === 0x0a) {
      keys.push({ type: 'special', value: 'ENTER' });
      i++;
      continue;
    }

    // Backspace (DEL or BS)
    if (byte === 0x7f || byte === 0x08) {
      keys.push({ type: 'special', value: 'BACKSPACE' });
      i++;
      continue;
    }

    // Tab
    if (byte === 0x09) {
      keys.push({ type: 'special', value: 'TAB' });
      i++;
      continue;
    }

    // Ctrl+A through Ctrl+Z (0x01-0x1A, excluding already handled)
    if (byte >= 0x01 && byte <= 0x1a) {
      const letter = String.fromCharCode(byte + 0x40); // Ctrl+A = 'A'
      keys.push({ type: 'ctrl', value: letter });
      i++;
      continue;
    }

    // Regular printable character (handle UTF-8)
    const str = data.subarray(i).toString('utf-8');
    if (str.length > 0) {
      const char = str[0]!;
      keys.push({ type: 'char', value: char });
      i += Buffer.byteLength(char, 'utf-8');
    } else {
      i++;
    }
  }

  return keys;
}
