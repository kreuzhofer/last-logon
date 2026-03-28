// Code-generated menu screens using box-drawing characters and ANSI colors
// These produce the classic BBS look without requiring hand-crafted .ans files

import { Color, setColor, resetColor, BoxChars } from './ansi.js';
import { center, padRight, padLeft } from '../utils/string-utils.js';

const D = BoxChars.double;
const S = BoxChars.single;
const BLK = BoxChars.block;

function colorize(fg: Color, text: string, bg?: Color): string {
  return setColor(fg, bg) + text + resetColor();
}

export function generateWelcomeScreen(bbsName: string, tagline: string): string {
  const w = 78;
  const lines: string[] = [];

  // Top border
  lines.push(colorize(Color.DarkCyan, D.topLeft + D.horizontal.repeat(w) + D.topRight));

  // Empty line
  lines.push(colorize(Color.DarkCyan, D.vertical) + ' '.repeat(w) + colorize(Color.DarkCyan, D.vertical));

  // BBS Name in big style
  const nameStr = center(bbsName, w);
  lines.push(
    colorize(Color.DarkCyan, D.vertical) +
    colorize(Color.LightCyan, nameStr) +
    colorize(Color.DarkCyan, D.vertical),
  );

  // Tagline
  const tagStr = center(`< ${tagline} >`, w);
  lines.push(
    colorize(Color.DarkCyan, D.vertical) +
    colorize(Color.DarkGray, tagStr) +
    colorize(Color.DarkCyan, D.vertical),
  );

  // Empty line
  lines.push(colorize(Color.DarkCyan, D.vertical) + ' '.repeat(w) + colorize(Color.DarkCyan, D.vertical));

  // Decorative gradient line (70 visible chars, centered in 78)
  const decoContent =
    colorize(Color.DarkBlue, BLK.light.repeat(10)) +
    colorize(Color.DarkCyan, BLK.medium.repeat(10)) +
    colorize(Color.LightCyan, BLK.dark.repeat(10)) +
    colorize(Color.White, BLK.full.repeat(10)) +
    colorize(Color.LightCyan, BLK.dark.repeat(10)) +
    colorize(Color.DarkCyan, BLK.medium.repeat(10)) +
    colorize(Color.DarkBlue, BLK.light.repeat(10));
  const decoVisibleWidth = 70;
  const decoPad = Math.floor((w - decoVisibleWidth) / 2);
  lines.push(
    colorize(Color.DarkCyan, D.vertical) +
    ' '.repeat(decoPad) + decoContent + ' '.repeat(w - decoVisibleWidth - decoPad) +
    colorize(Color.DarkCyan, D.vertical),
  );

  // Empty line
  lines.push(colorize(Color.DarkCyan, D.vertical) + ' '.repeat(w) + colorize(Color.DarkCyan, D.vertical));

  // Connection info lines
  const infoLines = [
    colorize(Color.White, '  Welcome, traveler. You have reached a place'),
    colorize(Color.White, '  where the digital frontier never faded.'),
    '',
    colorize(Color.DarkGray, '  Est. 2026  ') + colorize(Color.DarkCyan, S.vertical) + colorize(Color.DarkGray, '  SSH Access  ') + colorize(Color.DarkCyan, S.vertical) + colorize(Color.DarkGray, '  ANSI Terminal'),
  ];

  for (const line of infoLines) {
    const padding = w - stripAnsi(line).length;
    lines.push(
      colorize(Color.DarkCyan, D.vertical) +
      line + ' '.repeat(Math.max(0, padding)) +
      colorize(Color.DarkCyan, D.vertical),
    );
  }

  // Empty line
  lines.push(colorize(Color.DarkCyan, D.vertical) + ' '.repeat(w) + colorize(Color.DarkCyan, D.vertical));

  // Bottom border
  lines.push(colorize(Color.DarkCyan, D.bottomLeft + D.horizontal.repeat(w) + D.bottomRight));

  return lines.join('\r\n') + '\r\n';
}

export function generateMatrixMenu(): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(
    colorize(Color.LightCyan, '  [') +
    colorize(Color.White, 'L') +
    colorize(Color.LightCyan, ']') +
    colorize(Color.LightGray, ' Login') +
    '    ' +
    colorize(Color.LightCyan, '[') +
    colorize(Color.White, 'N') +
    colorize(Color.LightCyan, ']') +
    colorize(Color.LightGray, ' New User') +
    '    ' +
    colorize(Color.LightCyan, '[') +
    colorize(Color.White, 'Q') +
    colorize(Color.LightCyan, ']') +
    colorize(Color.LightGray, ' Quit'),
  );
  lines.push('');

  return lines.join('\r\n') + '\r\n';
}

export function generateMainMenu(handle: string, nodeNumber: number): string {
  const w = 78;
  const lines: string[] = [];

  // Header
  lines.push(colorize(Color.DarkCyan, D.topLeft + D.horizontal.repeat(w) + D.topRight));
  const headerText = center('M A I N   M E N U', w);
  lines.push(
    colorize(Color.DarkCyan, D.vertical) +
    colorize(Color.LightCyan, headerText) +
    colorize(Color.DarkCyan, D.vertical),
  );
  lines.push(colorize(Color.DarkCyan, D.bottomLeft + D.horizontal.repeat(w) + D.bottomRight));
  lines.push('');

  // Two-column menu layout
  const menuItems = [
    ['M', 'Message Areas', 'U', 'User Profile'],
    ['F', 'File Areas', 'W', 'Who\'s Online'],
    ['D', 'Door Games', 'L', 'Last Callers'],
    ['C', 'Chat/Conference', 'O', 'One-Liners'],
    ['B', 'Bulletins', 'V', 'Voting Booth'],
    ['S', 'System Stats', 'G', 'Goodbye/Logoff'],
  ];

  for (const [key1, label1, key2, label2] of menuItems) {
    const col1 =
      '  ' +
      colorize(Color.LightCyan, '[') +
      colorize(Color.White, key1!) +
      colorize(Color.LightCyan, ']') +
      ' ' +
      colorize(Color.LightGray, padRight(label1!, 20));

    const col2 =
      colorize(Color.LightCyan, '[') +
      colorize(Color.White, key2!) +
      colorize(Color.LightCyan, ']') +
      ' ' +
      colorize(Color.LightGray, padRight(label2!, 20));

    lines.push(col1 + '     ' + col2);
  }

  lines.push('');

  // Status bar
  lines.push(
    colorize(Color.DarkCyan, S.horizontal.repeat(80)),
  );
  lines.push(
    colorize(Color.DarkGray, ' Node: ') +
    colorize(Color.LightCyan, String(nodeNumber)) +
    colorize(Color.DarkGray, '  │  User: ') +
    colorize(Color.LightCyan, handle) +
    colorize(Color.DarkGray, '  │  ') +
    colorize(Color.DarkGray, new Date().toLocaleTimeString()),
  );
  lines.push('');

  return lines.join('\r\n') + '\r\n';
}

export function generateMessageAreaMenu(): string {
  const w = 78;
  const lines: string[] = [];

  lines.push(colorize(Color.DarkCyan, D.topLeft + D.horizontal.repeat(w) + D.topRight));
  const headerText = center('M E S S A G E   A R E A S', w);
  lines.push(
    colorize(Color.DarkCyan, D.vertical) +
    colorize(Color.LightCyan, headerText) +
    colorize(Color.DarkCyan, D.vertical),
  );
  lines.push(colorize(Color.DarkCyan, D.bottomLeft + D.horizontal.repeat(w) + D.bottomRight));
  lines.push('');

  const menuItems = [
    ['R', 'Read Messages'],
    ['P', 'Post New Message'],
    ['S', 'Scan New Messages'],
    ['C', 'Change Area'],
    ['Q', 'Return to Main Menu'],
  ];

  for (const [key, label] of menuItems) {
    lines.push(
      '  ' +
      colorize(Color.LightCyan, '[') +
      colorize(Color.White, key!) +
      colorize(Color.LightCyan, ']') +
      ' ' +
      colorize(Color.LightGray, label!),
    );
  }

  lines.push('');

  return lines.join('\r\n') + '\r\n';
}

export function generatePrompt(text: string): string {
  return (
    colorize(Color.LightCyan, text) +
    colorize(Color.DarkGray, ': ') +
    colorize(Color.White, '')
  );
}

// Strip ANSI escape sequences to get visible length
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}
