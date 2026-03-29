#!/usr/bin/env tsx
// Interactive Game & Puzzle Tester
// Run: npx tsx scripts/test-game.ts
//
// Tests puzzles, filesystem navigation, and narrative rendering
// without needing a full BBS session.

import * as readline from 'node:readline';
import {
  getBaseScript,
  getChapter,
  getChapterBeats,
  getBeat,
  getKillerPersonality,
  getPuzzleDefs,
  getPuzzleDef,
  getNPCDefs,
  getNPCDef,
  getFilesystemDef,
  getAIPrompts,
  interpolateTemplate,
} from '../src/game/base-script-loader.js';
import { validateAnswer } from '../src/game/puzzles/puzzle-engine.js';
import type { FSNode } from '../src/game/game-types.js';

// ─── Readline Helpers ───────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(prompt: string): Promise<string> {
  return new Promise(resolve => rl.question(prompt, resolve));
}

function print(text: string) {
  console.log(text);
}

function hr() {
  print('─'.repeat(60));
}

// ─── Filesystem Helpers (copy from hidden-terminal) ─────────────────────────

function resolvePath(currentPath: string[], input: string): string[] {
  if (input === '/') return [];
  if (input === '..') return currentPath.slice(0, -1);
  if (input === '.') return [...currentPath];
  const parts = input.startsWith('/')
    ? input.split('/').filter(Boolean)
    : [...currentPath, ...input.split('/').filter(Boolean)];
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

// ─── Main Menu ──────────────────────────────────────────────────────────────

async function mainMenu() {
  print('\n╔══════════════════════════════════════╗');
  print('║   Last Logon — Game Test Console     ║');
  print('╚══════════════════════════════════════╝\n');

  while (true) {
    hr();
    print('[1] Browse Base Script');
    print('[2] Test Puzzles');
    print('[3] Explore Filesystem');
    print('[4] View NPCs');
    print('[5] View AI Prompts');
    print('[6] Chapter & Beat Overview');
    print('[Q] Quit');
    hr();

    const choice = (await ask('> ')).trim().toUpperCase();

    switch (choice) {
      case '1': await browseScript(); break;
      case '2': await testPuzzles(); break;
      case '3': await exploreFilesystem(); break;
      case '4': await viewNPCs(); break;
      case '5': await viewAIPrompts(); break;
      case '6': await chapterOverview(); break;
      case 'Q': rl.close(); process.exit(0);
      default: print('Unknown option.');
    }
  }
}

// ─── 1. Browse Script ───────────────────────────────────────────────────────

async function browseScript() {
  const script = getBaseScript();
  print(`\n  Title: ${script.meta.title} v${script.meta.version}`);
  print(`  Chapters: ${script.meta.totalChapters}`);

  const personality = getKillerPersonality();
  print(`\n  Killer traits: ${personality.traits.join(', ')}`);
  print(`  Motivation: ${personality.motivation}`);
  print(`  Style: ${personality.style}`);
  await ask('\nPress Enter to continue...');
}

// ─── 2. Test Puzzles ────────────────────────────────────────────────────────

async function testPuzzles() {
  const puzzles = getPuzzleDefs();
  print(`\n  Found ${puzzles.length} puzzles:\n`);

  for (let i = 0; i < puzzles.length; i++) {
    print(`  [${i + 1}] ${puzzles[i]!.tag} (${puzzles[i]!.type}, ${puzzles[i]!.difficulty})`);
  }

  const choice = await ask('\nSelect puzzle # (or Q to go back): ');
  if (choice.toUpperCase() === 'Q') return;

  const idx = parseInt(choice, 10) - 1;
  if (idx < 0 || idx >= puzzles.length) {
    print('Invalid choice.');
    return;
  }

  const puzzle = puzzles[idx]!;
  hr();
  print(`\n  Puzzle: ${puzzle.tag}`);
  print(`  Type: ${puzzle.type} | Difficulty: ${puzzle.difficulty}`);
  print(`  Validator: ${puzzle.validator}`);
  print(`  Max Attempts: ${puzzle.maxAttempts}`);
  print(`\n  Presentation:\n`);
  print(puzzle.presentation);
  hr();

  if (puzzle.validator === 'ai') {
    print('\n  [AI-evaluated puzzle — cannot test offline]');
    print(`  Hint: The expected evidence includes topics from the story.`);
    await ask('\nPress Enter to continue...');
    return;
  }

  print('\n  Try to solve it! Type your answer (or "hints" to see hints, "answer" to reveal, "q" to quit):\n');

  let attempts = 0;
  let hintIdx = 0;

  while (true) {
    const answer = await ask('  > ');
    if (answer.toLowerCase() === 'q') break;

    if (answer.toLowerCase() === 'hints') {
      if (hintIdx < puzzle.hints.length) {
        print(`  Hint ${hintIdx + 1}: ${puzzle.hints[hintIdx]}`);
        hintIdx++;
      } else {
        print('  No more hints available.');
      }
      continue;
    }

    if (answer.toLowerCase() === 'answer') {
      print(`  Answers: ${(puzzle.answers ?? []).join(' | ')}`);
      if (puzzle.fuzzyTokens?.length) {
        print(`  Fuzzy tokens: ${puzzle.fuzzyTokens.join(', ')}`);
      }
      continue;
    }

    attempts++;
    const result = validateAnswer(puzzle, answer);

    if (result.correct) {
      print(`\n  ✓ CORRECT! Solved in ${attempts} attempt(s).`);
      if (puzzle.onSolve.clue) print(`  Clue revealed: ${puzzle.onSolve.clue}`);
      if (puzzle.onSolve.unlocks) print(`  Unlocks: ${puzzle.onSolve.unlocks.join(', ')}`);
      break;
    } else if (result.partial) {
      print('  ~ Partial match — you\'re on the right track...');
    } else {
      print('  ✗ Incorrect.');
    }

    if (attempts >= puzzle.maxAttempts) {
      print(`\n  Maximum attempts (${puzzle.maxAttempts}) reached.`);
      break;
    }
  }
}

// ─── 3. Explore Filesystem ──────────────────────────────────────────────────

async function exploreFilesystem() {
  const fsDef = getFilesystemDef();
  const root = fsDef.root;
  let currentPath: string[] = [];
  // All clues unlocked for testing
  const clues = ['hidden_system_access', 'server_region', 'victim_details'];

  print('\n  Pseudo-Filesystem Explorer (all clues unlocked for testing)');
  print('  Commands: ls, cd <path>, cat <file>, pwd, exit\n');

  while (true) {
    const pathStr = '/' + currentPath.join('/');
    const input = await ask(`  root@underground:${pathStr}$ `);
    const trimmed = input.trim();
    if (!trimmed) continue;

    const cmd = trimmed.split(/\s+/)[0]!.toLowerCase();
    const args = trimmed.substring(cmd.length).trim();

    switch (cmd) {
      case 'exit':
      case 'quit':
      case 'q':
        return;

      case 'ls': {
        const targetPath = args ? resolvePath(currentPath, args) : currentPath;
        const node = findNode(root, targetPath);
        if (!node || node.type !== 'directory') {
          print(`  ls: cannot access '${args || '.'}': No such directory`);
          break;
        }
        if (!node.children?.length) {
          print('  (empty directory)');
          break;
        }
        for (const child of node.children) {
          const hidden = child.hidden ? ' [HIDDEN]' : '';
          const clueGate = child.requiredClue ? ` (requires: ${child.requiredClue})` : '';
          const reveals = child.revealsClue ? ` -> reveals: ${child.revealsClue}` : '';
          const suffix = child.type === 'directory' ? '/' : '';
          print(`  ${child.name}${suffix}${hidden}${clueGate}${reveals}`);
        }
        break;
      }

      case 'cd': {
        if (!args) { currentPath = []; break; }
        const newPath = resolvePath(currentPath, args);
        const node = findNode(root, newPath);
        if (!node || node.type !== 'directory') {
          print(`  cd: ${args}: No such directory`);
        } else {
          currentPath = newPath;
        }
        break;
      }

      case 'cat': {
        if (!args) { print('  cat: missing operand'); break; }
        const targetPath = resolvePath(currentPath, args);
        const node = findNode(root, targetPath);
        if (!node) { print(`  cat: ${args}: No such file`); break; }
        if (node.type === 'directory') { print(`  cat: ${args}: Is a directory`); break; }
        print(node.content ?? '(empty file)');
        if (node.revealsClue) {
          print(`\n  [CLUE REVEALED: ${node.revealsClue}]`);
        }
        break;
      }

      case 'pwd':
        print('  ' + pathStr);
        break;

      default:
        print(`  ${cmd}: command not found`);
    }
  }
}

// ─── 4. View NPCs ──────────────────────────────────────────────────────────

async function viewNPCs() {
  const npcs = getNPCDefs();
  print(`\n  Found ${npcs.length} NPCs:\n`);

  for (const npc of npcs) {
    print(`  [${npc.tag}] ${npc.handle} — ${npc.role}`);
    print(`    Personality: ${npc.personality.substring(0, 70)}...`);
    if (npc.initialMessages?.length) {
      print(`    Initial messages: ${npc.initialMessages.length}`);
    }
    print('');
  }
  await ask('Press Enter to continue...');
}

// ─── 5. View AI Prompts ─────────────────────────────────────────────────────

async function viewAIPrompts() {
  const prompts = getAIPrompts();
  const keys = Object.keys(prompts);

  print(`\n  AI Prompt templates: ${keys.length}\n`);
  for (const key of keys) {
    const preview = (prompts as Record<string, string>)[key]!.substring(0, 100).replace(/\n/g, ' ');
    print(`  [${key}] ${preview}...`);
  }

  const choice = await ask('\nEnter prompt name to view full (or Enter to skip): ');
  if (choice && keys.includes(choice)) {
    hr();
    print((prompts as Record<string, string>)[choice]!);
    hr();

    // Show interpolated example
    const example = interpolateTemplate((prompts as Record<string, string>)[choice]!, {
      killerAlias: 'AXIOM',
      currentMood: 'curious',
      language: 'en',
      chapterTitle: 'Welcome to the Board',
      chapterDescription: 'Everything seems normal.',
      killerTraits: 'narcissistic, genius-level-intellect',
      killerMotivation: 'Recognition for brilliance.',
      killerStyle: 'Cat-and-mouse.',
      killerCommunication: 'Cryptic and playful.',
      suspicionLevel: '10',
      cluesFound: 'none',
      puzzlesSolved: 'none',
      storySummary: 'Player just started.',
      npcHandle: 'SIGNAL_LOST',
      npcRole: 'fellow_user',
      npcPersonality: 'Nervous, helpful.',
    });
    print('\n  [Interpolated example]:');
    print(example);
  }
  await ask('\nPress Enter to continue...');
}

// ─── 6. Chapter Overview ────────────────────────────────────────────────────

async function chapterOverview() {
  const script = getBaseScript();
  const chapters = Object.keys(script.chapters);

  print('\n  Chapter Overview:\n');
  for (const tag of chapters) {
    const ch = getChapter(tag as any);
    if (!ch) continue;

    const beats = getChapterBeats(tag as any);
    print(`  [${tag}] ${ch.title}`);
    print(`    Features: ${ch.features.join(', ')}`);
    print(`    Beats: ${beats.length}`);
    for (const beat of beats) {
      const triggerStr = beat.trigger === 'auto' ? 'auto' : JSON.stringify(beat.trigger);
      const scripted = beat.scriptedText ? ' [scripted]' : '';
      print(`      - ${beat.tag} (${triggerStr})${scripted}${beat.required ? ' [required]' : ''}`);
    }
    print('');
  }
  await ask('Press Enter to continue...');
}

// ─── Run ────────────────────────────────────────────────────────────────────

mainMenu().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
