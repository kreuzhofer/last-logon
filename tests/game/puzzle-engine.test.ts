// Tests for puzzle-engine.ts — validation strategies and answer checking

import { describe, it, expect } from 'vitest';
import { validateAnswer } from '../../src/game/puzzles/puzzle-engine.js';
import type { PuzzleDef } from '../../src/game/game-types.js';

function makePuzzle(overrides: Partial<PuzzleDef>): PuzzleDef {
  return {
    tag: 'test_puzzle',
    type: 'cipher',
    difficulty: 'easy',
    chapter: 'chapter1',
    presentation: 'Test puzzle',
    validator: 'exact',
    answers: [],
    hints: ['Hint 1'],
    maxAttempts: 5,
    onSolve: {},
    onFail: {},
    ...overrides,
  };
}

describe('validateAnswer — exact', () => {
  const puzzle = makePuzzle({
    validator: 'exact',
    answers: ['hello world', 'Hello World'],
  });

  it('should match exact answer (case insensitive)', () => {
    expect(validateAnswer(puzzle, 'hello world')).toEqual({ correct: true, partial: false });
    expect(validateAnswer(puzzle, 'HELLO WORLD')).toEqual({ correct: true, partial: false });
  });

  it('should trim whitespace', () => {
    expect(validateAnswer(puzzle, '  hello world  ')).toEqual({ correct: true, partial: false });
  });

  it('should reject wrong answer', () => {
    expect(validateAnswer(puzzle, 'goodbye')).toEqual({ correct: false, partial: false });
  });
});

describe('validateAnswer — fuzzy', () => {
  const puzzle = makePuzzle({
    validator: 'fuzzy',
    answers: ['the old map'],
    fuzzyTokens: ['old', 'map'],
  });

  it('should match exact answer', () => {
    expect(validateAnswer(puzzle, 'the old map')).toEqual({ correct: true, partial: false });
  });

  it('should match when all fuzzy tokens present', () => {
    expect(validateAnswer(puzzle, 'I found the old treasure map').correct).toBe(true);
  });

  it('should return partial when some tokens match', () => {
    const result = validateAnswer(puzzle, 'I found the old thing');
    expect(result.correct).toBe(false);
    expect(result.partial).toBe(true);
  });

  it('should reject when no tokens match', () => {
    expect(validateAnswer(puzzle, 'nothing here')).toEqual({ correct: false, partial: false });
  });
});

describe('validateAnswer — rot13', () => {
  const puzzle = makePuzzle({
    validator: 'rot13',
    answers: ['meet me at dawn'],
    fuzzyTokens: ['meet', 'dawn'],
  });

  it('should match decoded answer', () => {
    expect(validateAnswer(puzzle, 'meet me at dawn')).toEqual({ correct: true, partial: false });
  });

  it('should match via fuzzy tokens', () => {
    expect(validateAnswer(puzzle, 'you should meet me at dawn tomorrow').correct).toBe(true);
  });

  it('should return partial for some tokens', () => {
    const result = validateAnswer(puzzle, 'meet me later');
    expect(result.correct).toBe(false);
    expect(result.partial).toBe(true);
  });
});

describe('validateAnswer — numeric', () => {
  const puzzle = makePuzzle({
    validator: 'numeric',
    answers: ['42', '3.14'],
  });

  it('should match numeric answer', () => {
    expect(validateAnswer(puzzle, '42')).toEqual({ correct: true, partial: false });
    expect(validateAnswer(puzzle, '3.14')).toEqual({ correct: true, partial: false });
  });

  it('should match with whitespace', () => {
    expect(validateAnswer(puzzle, ' 42 ')).toEqual({ correct: true, partial: false });
  });

  it('should reject wrong number', () => {
    expect(validateAnswer(puzzle, '43')).toEqual({ correct: false, partial: false });
  });
});

describe('validateAnswer — contains', () => {
  const puzzle = makePuzzle({
    validator: 'contains',
    fuzzyTokens: ['server', 'berlin'],
  });

  it('should match when all tokens present', () => {
    expect(validateAnswer(puzzle, 'the server is in Berlin').correct).toBe(true);
  });

  it('should return partial when some tokens match', () => {
    const result = validateAnswer(puzzle, 'the server is somewhere');
    expect(result.correct).toBe(false);
    expect(result.partial).toBe(true);
  });

  it('should reject when no tokens match', () => {
    expect(validateAnswer(puzzle, 'no idea')).toEqual({ correct: false, partial: false });
  });
});

describe('validateAnswer — ai', () => {
  const puzzle = makePuzzle({ validator: 'ai' });

  it('should return false (AI validation is handled separately)', () => {
    expect(validateAnswer(puzzle, 'anything')).toEqual({ correct: false, partial: false });
  });
});

describe('validateAnswer — unknown validator', () => {
  const puzzle = makePuzzle({ validator: 'unknown' as any });

  it('should return false for unknown validator', () => {
    expect(validateAnswer(puzzle, 'anything')).toEqual({ correct: false, partial: false });
  });
});
