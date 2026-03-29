// Tests for game-layer.ts — pure/synchronous helpers and state logic

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getUnlockedFeatures,
  isFeatureUnlocked,
  hasClue,
  getCompletedBeats,
  isBeatCompleted,
  isPuzzleSolved,
  checkBeatTrigger,
  getTriggeredBeats,
} from '../../src/game/game-layer.js';
import type { StoryBeat, BeatTrigger } from '../../src/game/game-types.js';

// Minimal fake PlayerGame that satisfies the functions under test.
// These functions only read JSON string fields — they don't hit the DB.
function fakeGame(overrides: Record<string, unknown> = {}): any {
  return {
    id: 1,
    userId: 100,
    language: 'en',
    chapter: 'prologue',
    phase: 'prologue',
    killerAlias: 'AXIOM',
    killerMood: 'curious',
    killerTrust: 0,
    suspicionLevel: 0,
    totalSessions: 1,
    totalInteractions: 0,
    unlockedFeatures: JSON.stringify(['messages', 'oneliners']),
    activeClues: JSON.stringify([]),
    solvedPuzzles: JSON.stringify([]),
    completedBeats: JSON.stringify([]),
    discoveredSecrets: JSON.stringify([]),
    storyLog: JSON.stringify([]),
    flags: '{}',
    ...overrides,
  };
}

function fakeBeat(overrides: Partial<StoryBeat> = {}): StoryBeat {
  return {
    tag: 'test_beat',
    trigger: 'auto',
    required: false,
    ...overrides,
  } as StoryBeat;
}

// ─── Feature Unlocking ────────────────────────────────────────────────────

describe('getUnlockedFeatures', () => {
  it('should parse unlocked features from JSON', () => {
    const game = fakeGame();
    expect(getUnlockedFeatures(game)).toEqual(['messages', 'oneliners']);
  });

  it('should return empty array for invalid JSON', () => {
    const game = fakeGame({ unlockedFeatures: 'bad json' });
    expect(getUnlockedFeatures(game)).toEqual([]);
  });
});

describe('isFeatureUnlocked', () => {
  it('should return true for unlocked feature', () => {
    const game = fakeGame();
    expect(isFeatureUnlocked(game, 'messages')).toBe(true);
  });

  it('should return false for locked feature', () => {
    const game = fakeGame();
    expect(isFeatureUnlocked(game, 'hidden_files')).toBe(false);
  });

  it('should return true for any feature when wildcard is present', () => {
    const game = fakeGame({ unlockedFeatures: JSON.stringify(['*']) });
    expect(isFeatureUnlocked(game, 'anything')).toBe(true);
  });
});

// ─── Clue Management ──────────────────────────────────────────────────────

describe('hasClue', () => {
  it('should return true when clue exists', () => {
    const game = fakeGame({ activeClues: JSON.stringify(['news_disappearances']) });
    expect(hasClue(game, 'news_disappearances')).toBe(true);
  });

  it('should return false when clue missing', () => {
    const game = fakeGame();
    expect(hasClue(game, 'news_disappearances')).toBe(false);
  });
});

// ─── Beat Management ──────────────────────────────────────────────────────

describe('getCompletedBeats / isBeatCompleted', () => {
  it('should parse completed beats', () => {
    const game = fakeGame({ completedBeats: JSON.stringify(['first_login', 'strange_bulletin']) });
    expect(getCompletedBeats(game)).toEqual(['first_login', 'strange_bulletin']);
    expect(isBeatCompleted(game, 'first_login')).toBe(true);
    expect(isBeatCompleted(game, 'unknown')).toBe(false);
  });
});

// ─── Puzzle Management ────────────────────────────────────────────────────

describe('isPuzzleSolved', () => {
  it('should return true when puzzle is solved', () => {
    const game = fakeGame({ solvedPuzzles: JSON.stringify(['cipher_01']) });
    expect(isPuzzleSolved(game, 'cipher_01')).toBe(true);
  });

  it('should return false when puzzle is not solved', () => {
    const game = fakeGame();
    expect(isPuzzleSolved(game, 'cipher_01')).toBe(false);
  });
});

// ─── Beat Trigger Checking ──────────────────────────────────────────────

describe('checkBeatTrigger', () => {
  it('should trigger auto beats', () => {
    const beat = fakeBeat({ trigger: 'auto' });
    expect(checkBeatTrigger(beat, fakeGame())).toBe(true);
  });

  it('should not trigger already completed beats', () => {
    const beat = fakeBeat({ tag: 'first_login', trigger: 'auto' });
    const game = fakeGame({ completedBeats: JSON.stringify(['first_login']) });
    expect(checkBeatTrigger(beat, game)).toBe(false);
  });

  it('should trigger login_count when sessions met', () => {
    const trigger: BeatTrigger = { type: 'login_count', min: 3 };
    const beat = fakeBeat({ trigger });
    expect(checkBeatTrigger(beat, fakeGame({ totalSessions: 3 }))).toBe(true);
    expect(checkBeatTrigger(beat, fakeGame({ totalSessions: 2 }))).toBe(false);
  });

  it('should trigger interaction_count when met', () => {
    const trigger: BeatTrigger = { type: 'interaction_count', min: 5 };
    const beat = fakeBeat({ trigger });
    expect(checkBeatTrigger(beat, fakeGame({ totalInteractions: 5 }))).toBe(true);
    expect(checkBeatTrigger(beat, fakeGame({ totalInteractions: 4 }))).toBe(false);
  });

  it('should trigger area_visit when matching action', () => {
    const trigger: BeatTrigger = { type: 'area_visit', area: 'messages' };
    const beat = fakeBeat({ trigger });
    expect(checkBeatTrigger(beat, fakeGame(), { type: 'area_visit', value: 'messages' })).toBe(true);
    expect(checkBeatTrigger(beat, fakeGame(), { type: 'area_visit', value: 'oneliners' })).toBe(false);
  });

  it('should trigger clue_found when clue present', () => {
    const trigger: BeatTrigger = { type: 'clue_found', clue: 'news_disappearances' };
    const beat = fakeBeat({ trigger });
    const game = fakeGame({ activeClues: JSON.stringify(['news_disappearances']) });
    expect(checkBeatTrigger(beat, game)).toBe(true);
    expect(checkBeatTrigger(beat, fakeGame())).toBe(false);
  });

  it('should trigger puzzle_solved when puzzle done', () => {
    const trigger: BeatTrigger = { type: 'puzzle_solved', puzzle: 'cipher_01' };
    const beat = fakeBeat({ trigger });
    const game = fakeGame({ solvedPuzzles: JSON.stringify(['cipher_01']) });
    expect(checkBeatTrigger(beat, game)).toBe(true);
    expect(checkBeatTrigger(beat, fakeGame())).toBe(false);
  });

  it('should trigger player_action when matching', () => {
    const trigger: BeatTrigger = { type: 'player_action', action: 'read_bulletin' };
    const beat = fakeBeat({ trigger });
    expect(checkBeatTrigger(beat, fakeGame(), { type: 'player_action', value: 'read_bulletin' })).toBe(true);
    expect(checkBeatTrigger(beat, fakeGame(), { type: 'player_action', value: 'other' })).toBe(false);
  });
});

describe('getTriggeredBeats', () => {
  it('should return auto beats for prologue', () => {
    const game = fakeGame();
    const beats = getTriggeredBeats(game);
    // Should include first_login (auto beat) from prologue
    const tags = beats.map(b => b.tag);
    expect(tags).toContain('first_login');
  });

  it('should not return already completed beats', () => {
    const game = fakeGame({ completedBeats: JSON.stringify(['first_login']) });
    const beats = getTriggeredBeats(game);
    const tags = beats.map(b => b.tag);
    expect(tags).not.toContain('first_login');
  });
});
