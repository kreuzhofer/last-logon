// Tests for base-script-loader.ts — config file loading and parsing

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getBaseScript,
  getChapter,
  getChapterBeats,
  getBeat,
  getKillerPersonality,
  getClueDef,
  getPuzzleDefs,
  getPuzzleDef,
  getNPCDefs,
  getNPCDef,
  getFilesystemDef,
  getAIPrompts,
  getAIPrompt,
  interpolateTemplate,
  resetCache,
} from '../../src/game/base-script-loader.js';

describe('Base Script Loader', () => {
  beforeEach(() => {
    resetCache();
  });

  describe('getBaseScript', () => {
    it('should load the base script', () => {
      const script = getBaseScript();
      expect(script).toBeDefined();
      expect(script.meta.title).toBe('Last Logon');
      expect(script.meta.version).toBe('1.0.0');
    });

    it('should have a killer personality', () => {
      const personality = getKillerPersonality();
      expect(personality.traits).toBeInstanceOf(Array);
      expect(personality.traits.length).toBeGreaterThan(0);
      expect(personality.motivation).toBeTruthy();
    });

    it('should have chapters defined', () => {
      const script = getBaseScript();
      expect(script.chapters).toBeDefined();
      expect(script.chapters.prologue).toBeDefined();
      expect(script.chapters.chapter1).toBeDefined();
      expect(script.chapters.chapter2).toBeDefined();
    });
  });

  describe('getChapter', () => {
    it('should return a chapter by tag', () => {
      const prologue = getChapter('prologue');
      expect(prologue).toBeDefined();
      expect(prologue!.title).toBe('Welcome to the Board');
    });

    it('should return undefined for unknown chapter', () => {
      const result = getChapter('nonexistent' as any);
      expect(result).toBeUndefined();
    });
  });

  describe('getChapterBeats', () => {
    it('should return beats for a chapter', () => {
      const beats = getChapterBeats('prologue');
      expect(beats).toBeInstanceOf(Array);
      expect(beats.length).toBeGreaterThan(0);
      expect(beats[0]!.tag).toBe('first_login');
    });

    it('should return empty array for unknown chapter', () => {
      const beats = getChapterBeats('nonexistent' as any);
      expect(beats).toEqual([]);
    });
  });

  describe('getBeat', () => {
    it('should find a specific beat in a chapter', () => {
      const beat = getBeat('prologue', 'first_login');
      expect(beat).toBeDefined();
      expect(beat!.trigger).toBe('auto');
      expect(beat!.required).toBe(true);
    });

    it('should have scripted text for first beats', () => {
      const beat = getBeat('prologue', 'first_login');
      expect(beat!.scriptedText).toBeTruthy();
      expect(beat!.scriptedTextDe).toBeTruthy();
    });
  });

  describe('getClueDef', () => {
    it('should return a clue definition', () => {
      const clue = getClueDef('news_disappearances');
      expect(clue).toBeDefined();
      expect(clue!.evidenceWeight).toBeGreaterThan(0);
    });
  });
});

describe('Puzzle Definitions', () => {
  beforeEach(() => {
    resetCache();
  });

  it('should load puzzle definitions', () => {
    const puzzles = getPuzzleDefs();
    expect(puzzles).toBeInstanceOf(Array);
    expect(puzzles.length).toBeGreaterThan(0);
  });

  it('should find cipher_01 puzzle', () => {
    const cipher = getPuzzleDef('cipher_01');
    expect(cipher).toBeDefined();
    expect(cipher!.type).toBe('cipher');
    expect(cipher!.validator).toBe('rot13');
    expect(cipher!.answers!.length).toBeGreaterThan(0);
  });

  it('should find riddle_01 puzzle', () => {
    const riddle = getPuzzleDef('riddle_01');
    expect(riddle).toBeDefined();
    expect(riddle!.type).toBe('riddle');
    expect(riddle!.validator).toBe('fuzzy');
  });

  it('should have hints for each puzzle', () => {
    const puzzles = getPuzzleDefs();
    for (const puzzle of puzzles) {
      expect(puzzle.hints.length).toBeGreaterThan(0);
      expect(puzzle.maxAttempts).toBeGreaterThan(0);
    }
  });
});

describe('NPC Definitions', () => {
  beforeEach(() => {
    resetCache();
  });

  it('should load NPC definitions', () => {
    const npcs = getNPCDefs();
    expect(npcs).toBeInstanceOf(Array);
    expect(npcs.length).toBeGreaterThan(0);
  });

  it('should find worried_user NPC', () => {
    const npc = getNPCDef('worried_user');
    expect(npc).toBeDefined();
    expect(npc!.handle).toBe('SIGNAL_LOST');
    expect(npc!.role).toBe('fellow_user');
  });

  it('should find investigator NPC', () => {
    const npc = getNPCDef('investigator');
    expect(npc).toBeDefined();
    expect(npc!.handle).toBe('D_COLE');
    expect(npc!.role).toBe('investigator');
  });
});

describe('Filesystem Definition', () => {
  beforeEach(() => {
    resetCache();
  });

  it('should load filesystem definition', () => {
    const fs = getFilesystemDef();
    expect(fs).toBeDefined();
    expect(fs.root).toBeDefined();
    expect(fs.root.type).toBe('directory');
  });

  it('should have a /system directory', () => {
    const fs = getFilesystemDef();
    const system = fs.root.children?.find(c => c.name === 'system');
    expect(system).toBeDefined();
    expect(system!.type).toBe('directory');
  });

  it('should have hidden files with required clues', () => {
    const fs = getFilesystemDef();
    const system = fs.root.children?.find(c => c.name === 'system');
    const privateDir = system?.children?.find(c => c.name === 'private');
    expect(privateDir).toBeDefined();
    expect(privateDir!.hidden).toBe(true);
    expect(privateDir!.requiredClue).toBe('hidden_system_access');
  });
});

describe('AI Prompts', () => {
  beforeEach(() => {
    resetCache();
  });

  it('should load AI prompts', () => {
    const prompts = getAIPrompts();
    expect(prompts).toBeDefined();
    expect(prompts.killerSystemPrompt).toBeTruthy();
    expect(prompts.npcSystemPrompt).toBeTruthy();
  });

  it('should have template variables in prompts', () => {
    const prompt = getAIPrompt('killerSystemPrompt');
    expect(prompt).toContain('{killerAlias}');
    expect(prompt).toContain('{currentMood}');
    expect(prompt).toContain('{language}');
  });
});

describe('interpolateTemplate', () => {
  it('should replace variables in template', () => {
    const result = interpolateTemplate('Hello {name}, you are {age} years old', {
      name: 'Alice',
      age: 30,
    });
    expect(result).toBe('Hello Alice, you are 30 years old');
  });

  it('should leave unknown variables as-is', () => {
    const result = interpolateTemplate('Hello {name}, {unknown}', { name: 'Bob' });
    expect(result).toBe('Hello Bob, {unknown}');
  });
});
