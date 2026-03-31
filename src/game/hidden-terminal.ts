// Hidden Terminal — Pseudo-filesystem shell for "hacking" sequences
// Provides ls, cd, cat, grep, pwd, whoami commands within a fake filesystem

import { Color, setColor, resetColor } from '../terminal/ansi.js';
import { parsePipeCodes, stripPipeCodes } from '../utils/pipe-codes.js';
import { stripAnsi } from '../utils/string-utils.js';
import { getFilesystemDef } from './base-script-loader.js';
import { addClue, hasClue, addStoryLogEntry, addGameEvent, getTriggeredBeats, buildStoryContext } from './game-layer.js';
import { processBeat } from './screens.js';
import { createChildLogger } from '../core/logger.js';
import { getConfig } from '../core/config.js';
import type { Terminal } from '../terminal/terminal.js';
import type { ScreenFrame, HotkeyDef } from '../terminal/screen-frame.js';
import type { Session } from '../auth/session.js';
import type { FSNode, StoryContext } from './game-types.js';
import type { PlayerGame } from '@prisma/client';

const log = createChildLogger('hidden-terminal');

/** Write a line to the frame, wrapping if it exceeds content width */
function writeWrapped(frame: ScreenFrame, text: string): void {
  const maxWidth = frame.contentWidth;
  // Strip ANSI/pipe codes to measure visible length
  const visible = stripAnsi(stripPipeCodes(text));

  if (visible.length <= maxWidth) {
    frame.writeContentLine(text);
    return;
  }

  // Need to wrap — split into chunks by visible width
  // This is approximate since ANSI codes make exact splitting hard
  // For simplicity, wrap the visible text and re-apply the color prefix
  const words = visible.split(' ');
  let currentLine = '';

  for (const word of words) {
    const testLen = currentLine.length + (currentLine ? 1 : 0) + word.length;
    if (testLen > maxWidth && currentLine) {
      frame.writeContentLine(setColor(Color.LightGray) + currentLine + resetColor());
      currentLine = '  ' + word; // indent continuation
    } else {
      currentLine += (currentLine ? ' ' : '') + word;
    }
  }
  if (currentLine) {
    frame.writeContentLine(setColor(Color.LightGray) + currentLine + resetColor());
  }
}

const HOTKEYS_TERMINAL: HotkeyDef[] = [
  { key: 'Q', label: 'Exit' },
];

// ─── Filesystem Navigation ───────────────────────────────────────────────────

function resolvePath(currentPath: string[], input: string): string[] {
  if (input === '/') return [];
  if (input === '..') return currentPath.slice(0, -1);
  if (input === '.') return [...currentPath];

  const parts = input.startsWith('/')
    ? input.split('/').filter(Boolean)
    : [...currentPath, ...input.split('/').filter(Boolean)];

  // Resolve .. in path
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') resolved.pop();
    else if (part !== '.') resolved.push(part);
  }
  return resolved;
}

function findNode(root: FSNode, path: string[]): FSNode | null {
  let current = root;
  for (const part of path) {
    if (current.type !== 'directory' || !current.children) return null;
    const child = current.children.find(c => c.name === part);
    if (!child) return null;
    current = child;
  }
  return current;
}

function isNodeVisible(node: FSNode, cluesFound: string[]): boolean {
  if (!node.hidden && !node.requiredClue) return true;
  if (node.requiredClue && cluesFound.includes(node.requiredClue)) return true;
  if (!node.requiredClue && !node.hidden) return true;
  return false;
}

function getPathString(path: string[]): string {
  return '/' + path.join('/');
}

// ─── Tab Completion ─────────────────────────────────────────────────────────

const COMMANDS = ['ls', 'cd', 'cat', 'grep', 'decode', 'pwd', 'whoami', 'help', 'exit', 'quit', 'clear'];

function getCompletions(root: FSNode, currentPath: string[], cluesFound: string[], buffer: string): string[] {
  const parts = buffer.split(/\s+/);

  // Complete command name
  if (parts.length <= 1) {
    const partial = parts[0]?.toLowerCase() ?? '';
    return COMMANDS.filter(c => c.startsWith(partial)).map(c => c + ' ');
  }

  // Complete path argument for cd, ls, cat, grep
  const cmd = parts[0]!.toLowerCase();
  if (!['cd', 'ls', 'cat', 'grep'].includes(cmd)) return [];

  const argParts = parts.slice(1).join(' ');

  // Split the path argument to find what we're completing
  const pathSegments = argParts.split('/');
  const partialName = pathSegments.pop() ?? '';
  const parentPathStr = pathSegments.join('/');

  // Resolve the parent directory
  let dirPath: string[];
  if (argParts.startsWith('/')) {
    dirPath = parentPathStr ? parentPathStr.split('/').filter(Boolean) : [];
  } else {
    dirPath = parentPathStr ? resolvePath(currentPath, parentPathStr) : [...currentPath];
  }

  const dirNode = findNode(root, dirPath);
  if (!dirNode || dirNode.type !== 'directory' || !dirNode.children) return [];

  // Find matching children
  const visibleChildren = dirNode.children.filter(c => isNodeVisible(c, cluesFound));
  const matches = visibleChildren.filter(c => c.name.startsWith(partialName));

  if (matches.length === 0) return [];

  // Build the completed buffer for each match
  const prefix = cmd + ' ' + (parentPathStr ? parentPathStr + '/' : (argParts.startsWith('/') ? '/' : ''));

  return matches.map(m => {
    const suffix = m.type === 'directory' ? m.name + '/' : m.name;
    return prefix + suffix;
  });
}

// ─── Command Handlers ────────────────────────────────────────────────────────

function cmdLs(
  root: FSNode,
  currentPath: string[],
  args: string,
  cluesFound: string[],
): string[] {
  // Parse flags
  let showLong = false;
  let showAll = false;
  let pathArg = '';

  const parts = args.split(/\s+/).filter(Boolean);
  for (const part of parts) {
    if (part.startsWith('-')) {
      if (part.includes('l')) showLong = true;
      if (part.includes('a')) showAll = true;
    } else {
      pathArg = part;
    }
  }

  const targetPath = pathArg ? resolvePath(currentPath, pathArg) : currentPath;
  const node = findNode(root, targetPath);

  if (!node || node.type !== 'directory') {
    return [`ls: cannot access '${pathArg || '.'}': No such directory`];
  }

  if (!node.children?.length) {
    return ['(empty directory)'];
  }

  const lines: string[] = [];

  // Show . and .. with -a
  if (showAll) {
    if (showLong) {
      lines.push(setColor(Color.LightCyan) + 'drwxr-xr-x  ' + setColor(Color.White) + 'root  root  ' + setColor(Color.LightCyan) + '.' + resetColor());
      lines.push(setColor(Color.LightCyan) + 'drwxr-xr-x  ' + setColor(Color.White) + 'root  root  ' + setColor(Color.LightCyan) + '..' + resetColor());
    } else {
      lines.push(setColor(Color.LightCyan) + '.  ..' + resetColor());
    }
  }

  if (showLong) {
    lines.push(setColor(Color.DarkGray) + 'total ' + node.children.filter(c => isNodeVisible(c, cluesFound)).length + resetColor());
  }

  for (const child of node.children) {
    if (!isNodeVisible(child, cluesFound)) continue;

    const isDir = child.type === 'directory';
    const nameColor = isDir ? Color.LightCyan : Color.LightGray;
    const suffix = isDir ? '/' : '';

    if (showLong) {
      const perms = isDir ? 'drwxr-xr-x' : '-rw-r--r--';
      const size = child.content ? String(child.content.length).padStart(5) : (isDir ? '  4096' : '     0');
      const owner = child.hidden ? setColor(Color.DarkRed) + 'axiom ' : setColor(Color.White) + 'root  ';
      const date = 'Mar 15  2026';

      lines.push(
        setColor(Color.DarkGray) + perms + '  ' +
        owner + setColor(Color.White) + 'root  ' +
        setColor(Color.DarkGray) + size + ' ' + date + '  ' +
        setColor(nameColor) + child.name + suffix + resetColor(),
      );
    } else {
      lines.push(setColor(nameColor) + child.name + suffix + resetColor());
    }
  }

  return lines.length ? lines : ['(empty directory)'];
}

function cmdCat(
  root: FSNode,
  currentPath: string[],
  args: string,
  language: string,
  cluesFound: string[],
): { lines: string[]; revealsClue?: string } {
  if (!args) return { lines: ['cat: missing operand'] };

  const targetPath = resolvePath(currentPath, args);
  const node = findNode(root, targetPath);

  if (!node) return { lines: [`cat: ${args}: No such file or directory`] };
  if (node.type === 'directory') return { lines: [`cat: ${args}: Is a directory`] };
  if (!isNodeVisible(node, cluesFound)) return { lines: [`cat: ${args}: Permission denied`] };

  const content = (language === 'de' && node.contentDe) ? node.contentDe : node.content;
  const lines = content ? content.trim().split('\n') : ['(empty file)'];

  return { lines, revealsClue: node.revealsClue };
}

function cmdGrep(
  root: FSNode,
  currentPath: string[],
  args: string,
  cluesFound: string[],
): string[] {
  const parts = args.split(/\s+/);
  if (parts.length < 2) return ['grep: Usage: grep <pattern> <file>'];

  const pattern = parts[0]!.toLowerCase();
  const filePath = parts.slice(1).join(' ');
  const targetPath = resolvePath(currentPath, filePath);
  const node = findNode(root, targetPath);

  if (!node) return [`grep: ${filePath}: No such file or directory`];
  if (node.type === 'directory') return [`grep: ${filePath}: Is a directory`];
  if (!isNodeVisible(node, cluesFound)) return [`grep: ${filePath}: Permission denied`];

  const content = node.content ?? '';
  const matches = content.split('\n').filter(line =>
    line.toLowerCase().includes(pattern)
  );

  return matches.length ? matches.map(l => l.trim()) : [`grep: no matches for '${pattern}'`];
}

// ─── Main Terminal Loop ──────────────────────────────────────────────────────

export async function runHiddenTerminal(
  session: Session,
  frame: ScreenFrame,
  game: PlayerGame,
  context: StoryContext,
): Promise<void> {
  const terminal = session.terminal;
  const config = getConfig();
  const fsDef = getFilesystemDef();
  const root = fsDef.root;
  let currentPath: string[] = [];
  const cluesFound = [...context.cluesFound];

  await addGameEvent(game, 'area_visit', 'Entered hidden terminal', { area: 'hiddenTerminal' }, 5);

  while (true) {
    frame.refresh([config.general.bbsName, 'SYSTEM ACCESS'], HOTKEYS_TERMINAL);
    frame.skipLine();

    // Display current path and prompt
    const pathStr = getPathString(currentPath);
    frame.writeContentLine(
      setColor(Color.DarkGray) + 'Hidden Terminal v1.0 — ' +
      setColor(Color.LightRed) + 'UNAUTHORIZED ACCESS' +
      resetColor(),
    );
    frame.writeContentLine(
      setColor(Color.DarkGray) + 'Type "help" for commands. "exit" to leave.' +
      resetColor(),
    );
    frame.skipLine();

    // Command loop within this screen
    let running = true;
    while (running) {
      // Refresh screen if running low on space
      if (frame.remainingRows <= 3) {
        frame.refresh([config.general.bbsName, 'SYSTEM ACCESS'], HOTKEYS_TERMINAL);
        frame.skipLine();
        frame.writeContentLine(
          setColor(Color.DarkGray) + 'Hidden Terminal v1.0 — ' +
          setColor(Color.LightRed) + 'UNAUTHORIZED ACCESS' + resetColor(),
        );
        frame.skipLine();
      }

      // Use current path for prompt (updates after cd)
      const promptPath = getPathString(currentPath);
      terminal.moveTo(frame.currentRow, frame.contentLeft);
      terminal.write(
        setColor(Color.LightGreen) + 'root' +
        setColor(Color.DarkGray) + '@' +
        setColor(Color.LightCyan) + 'underground' +
        setColor(Color.DarkGray) + ':' +
        setColor(Color.LightCyan) + promptPath +
        setColor(Color.White) + '$ ' + resetColor(),
      );

      const input = await terminal.readLineWithCompletion({
        maxLength: 60,
        completionFn: (buf) => getCompletions(root, currentPath, cluesFound, buf),
      });
      frame.setContentRow(frame.currentRow - frame.contentTop + 1);

      if (!input) continue;

      const trimmed = input.trim();
      const currentCmd = trimmed.split(/\s+/)[0]?.toLowerCase() ?? '';
      const args = trimmed.substring(currentCmd.length).trim();

      switch (currentCmd) {
        case 'exit':
        case 'quit':
        case 'q':
          running = false;
          break;

        case 'help': {
          const helpLines = [
            '|07Available commands:',
            '|11  ls [path]       |07— List directory contents',
            '|11  cd <path>       |07— Change directory',
            '|11  cat <file>      |07— Display file contents',
            '|11  grep <pat> <f>  |07— Search in file',
            '|11  decode <text>   |07— Analyze decoded text',
            '|11  pwd             |07— Print working directory',
            '|11  whoami          |07— Show current user',
            '|11  clear           |07— Clear screen',
            '|11  exit            |07— Exit terminal',
          ];
          for (const line of helpLines) {
            if (frame.remainingRows <= 1) break;
            frame.writeContentLine(parsePipeCodes(line));
          }
          break;
        }

        case 'ls': {
          const lines = cmdLs(root, currentPath, args, cluesFound);
          for (const line of lines) {
            if (frame.remainingRows <= 2) {
              terminal.moveTo(frame.currentRow, frame.contentLeft);
              terminal.write(setColor(Color.DarkGray) + '--- more ---' + resetColor());
              await terminal.readKey();
              frame.refresh([config.general.bbsName, 'SYSTEM ACCESS'], HOTKEYS_TERMINAL);
              frame.skipLine();
            }
            writeWrapped(frame, line);
          }
          break;
        }

        case 'cd': {
          if (!args) {
            currentPath = [];
          } else {
            const newPath = resolvePath(currentPath, args);
            const node = findNode(root, newPath);
            if (!node || node.type !== 'directory') {
              frame.writeContentLine(`cd: ${args}: No such directory`);
            } else if (!isNodeVisible(node, cluesFound)) {
              frame.writeContentLine(`cd: ${args}: Permission denied`);
            } else {
              currentPath = newPath;
            }
          }
          break;
        }

        case 'cat': {
          const result = cmdCat(root, currentPath, args, game.language, cluesFound);
          for (const line of result.lines) {
            if (frame.remainingRows <= 2) {
              terminal.moveTo(frame.currentRow, frame.contentLeft);
              terminal.write(setColor(Color.DarkGray) + '--- more ---' + resetColor());
              await terminal.readKey();
              frame.refresh([config.general.bbsName, 'SYSTEM ACCESS'], HOTKEYS_TERMINAL);
              frame.skipLine();
            }
            writeWrapped(frame, parsePipeCodes(line));
          }
          if (result.revealsClue && !cluesFound.includes(result.revealsClue)) {
            cluesFound.push(result.revealsClue);
            await addClue(game, result.revealsClue);
            frame.skipLine();
            const clueMsg = game.language === 'de'
              ? '|10[HINWEIS ENTDECKT]|08'
              : '|10[CLUE DISCOVERED]|08';
            frame.writeContentLine(parsePipeCodes(clueMsg));
          }

          // Fire area_visit beats based on file path accessed
          const filePath = args ? resolvePath(currentPath, args).join('/') : currentPath.join('/');
          if (filePath.startsWith('system/logs')) {
            const beats = getTriggeredBeats(game, { type: 'area_visit', value: 'systemLogs' });
            for (const beat of beats) {
              await processBeat(beat, game, session, frame, context);
            }
          }
          if (filePath.startsWith('system/private')) {
            const beats = getTriggeredBeats(game, { type: 'area_visit', value: 'hiddenFiles' });
            for (const beat of beats) {
              await processBeat(beat, game, session, frame, context);
            }
          }
          break;
        }

        case 'grep': {
          const lines = cmdGrep(root, currentPath, args, cluesFound);
          for (const line of lines) {
            if (frame.remainingRows <= 2) {
              terminal.moveTo(frame.currentRow, frame.contentLeft);
              terminal.write(setColor(Color.DarkGray) + '--- more ---' + resetColor());
              await terminal.readKey();
              frame.refresh([config.general.bbsName, 'SYSTEM ACCESS'], HOTKEYS_TERMINAL);
              frame.skipLine();
            }
            writeWrapped(frame, parsePipeCodes(line));
          }
          break;
        }

        case 'pwd':
          frame.writeContentLine(getPathString(currentPath));
          break;

        case 'whoami':
          frame.writeContentLine(setColor(Color.LightRed) + 'root' + resetColor() +
            setColor(Color.DarkGray) + ' (how did you get root access?)' + resetColor());
          break;

        case 'decode': {
          if (!args) {
            frame.writeContentLine(setColor(Color.DarkGray) + 'Usage: decode <text>' + resetColor());
            break;
          }
          frame.writeContentLine(setColor(Color.DarkGray) + 'Analyzing: ' + setColor(Color.White) + args + resetColor());
          const { checkTextAgainstPendingPuzzles: checkPuzzle, applyPuzzleSolvedEffects: applyEffects } = await import('./puzzles/puzzle-recognizer.js');
          const match = checkPuzzle(game, args, 'terminal');
          if (match) {
            await applyEffects(game, match.puzzleTag, 'terminal');
            frame.writeContentLine(setColor(Color.LightGreen) + '[PATTERN MATCH — DATA CORRELATES WITH SYSTEM ANOMALY]' + resetColor());
            frame.writeContentLine(setColor(Color.LightGreen) + '[DISCOVERY LOGGED]' + resetColor());
          } else {
            frame.writeContentLine(setColor(Color.DarkGray) + 'No recognizable pattern found.' + resetColor());
          }
          break;
        }

        case 'clear':
          // Re-render frame, effectively clearing
          running = false; // Will re-enter the outer loop
          break;

        default:
          frame.writeContentLine(
            setColor(Color.DarkGray) + `${currentCmd}: command not found` + resetColor(),
          );
      }
    }

    if (!running) break;
    // Screen is full, loop back to re-render
  }
}
