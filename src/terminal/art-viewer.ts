// ANSI Art Viewer — loads .ans files and displays them in the ScreenFrame
// Art files use pipe codes (|00-|23) for colors and must fit within 76 chars wide

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getProjectRoot } from '../core/config.js';
import { parsePipeCodes } from '../utils/pipe-codes.js';
import type { ScreenFrame } from './screen-frame.js';

// Cache loaded art files
const artCache = new Map<string, string[]>();

/**
 * Load an ANSI art file from the art/ directory.
 * Returns array of lines with pipe codes, or null if file doesn't exist.
 */
export function loadArt(filename: string): string[] | null {
  const cached = artCache.get(filename);
  if (cached) return cached;

  const artPath = resolve(getProjectRoot(), 'art', filename);
  if (!existsSync(artPath)) return null;

  const content = readFileSync(artPath, 'utf-8');
  const lines = content.split('\n');
  artCache.set(filename, lines);
  return lines;
}

/**
 * Display ANSI art in the ScreenFrame content area.
 * Each line is rendered with pipe codes parsed.
 * Returns the number of rows used.
 */
export function displayArt(frame: ScreenFrame, filename: string): number {
  const lines = loadArt(filename);
  if (!lines) return 0;

  let rowsUsed = 0;
  for (const line of lines) {
    if (frame.remainingRows <= 0) break;
    frame.writeContentLine(parsePipeCodes(line));
    rowsUsed++;
  }

  return rowsUsed;
}

/**
 * Check if an art file exists.
 */
export function hasArt(filename: string): boolean {
  if (artCache.has(filename)) return true;
  const artPath = resolve(getProjectRoot(), 'art', filename);
  return existsSync(artPath);
}
