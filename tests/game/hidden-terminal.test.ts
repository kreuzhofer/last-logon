// Tests for hidden-terminal.ts — filesystem navigation helpers
// We test the internal pure functions by importing the module and exercising
// the exported runHiddenTerminal indirectly (the helpers are module-private,
// so we test the filesystem definition loading and the navigation logic via
// base-script-loader).

import { describe, it, expect, beforeEach } from 'vitest';
import { getFilesystemDef, resetCache } from '../../src/game/base-script-loader.js';
import type { FSNode } from '../../src/game/game-types.js';

// Replicate the pure helpers from hidden-terminal.ts for testing
// (they are not exported, so we recreate the logic here)

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

function isNodeVisible(node: FSNode, cluesFound: string[]): boolean {
  if (!node.hidden && !node.requiredClue) return true;
  if (node.requiredClue && cluesFound.includes(node.requiredClue)) return true;
  if (!node.requiredClue && !node.hidden) return true;
  return false;
}

describe('resolvePath', () => {
  it('should resolve / to root', () => {
    expect(resolvePath(['system'], '/')).toEqual([]);
  });

  it('should resolve .. to parent', () => {
    expect(resolvePath(['system', 'logs'], '..')).toEqual(['system']);
  });

  it('should resolve . to current', () => {
    expect(resolvePath(['system'], '.')).toEqual(['system']);
  });

  it('should resolve relative path', () => {
    expect(resolvePath(['system'], 'logs')).toEqual(['system', 'logs']);
  });

  it('should resolve absolute path', () => {
    expect(resolvePath(['system'], '/home/axiom')).toEqual(['home', 'axiom']);
  });

  it('should resolve .. in path', () => {
    expect(resolvePath([], 'system/../home')).toEqual(['home']);
  });

  it('should handle empty parent on ..', () => {
    expect(resolvePath([], '..')).toEqual([]);
  });

  it('should handle nested path segments', () => {
    expect(resolvePath([], 'system/logs')).toEqual(['system', 'logs']);
  });
});

describe('Filesystem Definition', () => {
  beforeEach(() => {
    resetCache();
  });

  it('should load root node', () => {
    const fs = getFilesystemDef();
    expect(fs.root).toBeDefined();
    expect(fs.root.type).toBe('directory');
    expect(fs.root.name).toBe('/');
  });

  it('should find /system directory', () => {
    const fs = getFilesystemDef();
    const system = findNode(fs.root, ['system']);
    expect(system).not.toBeNull();
    expect(system!.type).toBe('directory');
  });

  it('should find /system/motd.txt', () => {
    const fs = getFilesystemDef();
    const motd = findNode(fs.root, ['system', 'motd.txt']);
    expect(motd).not.toBeNull();
    expect(motd!.type).toBe('file');
    expect(motd!.content).toBeTruthy();
  });

  it('should return null for nonexistent path', () => {
    const fs = getFilesystemDef();
    expect(findNode(fs.root, ['nonexistent'])).toBeNull();
  });

  it('should return null when traversing through file', () => {
    const fs = getFilesystemDef();
    expect(findNode(fs.root, ['system', 'motd.txt', 'child'])).toBeNull();
  });
});

describe('isNodeVisible', () => {
  it('should show non-hidden nodes without requiredClue', () => {
    const node: FSNode = { name: 'test', type: 'file' };
    expect(isNodeVisible(node, [])).toBe(true);
  });

  it('should hide nodes with requiredClue when clue not found', () => {
    const node: FSNode = { name: 'secret', type: 'directory', hidden: true, requiredClue: 'hidden_system_access' };
    expect(isNodeVisible(node, [])).toBe(false);
  });

  it('should show hidden nodes when requiredClue is found', () => {
    const node: FSNode = { name: 'secret', type: 'directory', hidden: true, requiredClue: 'hidden_system_access' };
    expect(isNodeVisible(node, ['hidden_system_access'])).toBe(true);
  });

  it('should hide purely hidden nodes (no requiredClue)', () => {
    const node: FSNode = { name: 'hidden', type: 'file', hidden: true };
    expect(isNodeVisible(node, [])).toBe(false);
  });
});

describe('Filesystem clue gating', () => {
  beforeEach(() => {
    resetCache();
  });

  it('should have hidden private directory gated by clue', () => {
    const fs = getFilesystemDef();
    const system = findNode(fs.root, ['system']);
    const priv = system?.children?.find(c => c.name === 'private');
    expect(priv).toBeDefined();
    expect(priv!.hidden).toBe(true);
    expect(priv!.requiredClue).toBe('hidden_system_access');
    expect(isNodeVisible(priv!, [])).toBe(false);
    expect(isNodeVisible(priv!, ['hidden_system_access'])).toBe(true);
  });

  it('should have files that reveal clues', () => {
    const fs = getFilesystemDef();
    // notes.txt in /system/private should reveal victim_details
    const notes = findNode(fs.root, ['system', 'private', 'notes.txt']);
    expect(notes).not.toBeNull();
    expect(notes!.revealsClue).toBe('victim_details');
  });
});
