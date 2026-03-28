// Loads and parses the base script and related config files
// Provides typed access to chapters, puzzles, NPCs, and filesystem definitions

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import hjson from 'hjson';
import { getProjectRoot } from '../core/config.js';
import { createChildLogger } from '../core/logger.js';
import type {
  BaseScript,
  PuzzleDef,
  NPCTemplate,
  FilesystemDef,
  ChapterTag,
  StoryBeat,
  BeatTrigger,
} from './game-types.js';

const log = createChildLogger('base-script');

// ─── Cached configs ──────────────────────────────────────────────────────────

let baseScript: BaseScript | undefined;
let puzzleDefs: PuzzleDef[] | undefined;
let npcDefs: Array<NPCTemplate & { tag: string; initialMessages?: unknown[]; oneLiners?: string[] }> | undefined;
let filesystemDef: FilesystemDef | undefined;
let aiPrompts: Record<string, string> | undefined;

function loadHjson<T>(relativePath: string): T {
  const fullPath = resolve(getProjectRoot(), relativePath);
  const raw = readFileSync(fullPath, 'utf-8');
  return hjson.parse(raw) as T;
}

// ─── Base Script ─────────────────────────────────────────────────────────────

export function getBaseScript(): BaseScript {
  if (!baseScript) {
    baseScript = loadHjson<BaseScript>('config/base-script.hjson');
    log.info('Base script loaded');
  }
  return baseScript;
}

export function getChapter(tag: ChapterTag): BaseScript['chapters'][ChapterTag] | undefined {
  return getBaseScript().chapters[tag];
}

export function getChapterBeats(tag: ChapterTag): StoryBeat[] {
  const chapter = getChapter(tag);
  return chapter?.beats ?? [];
}

export function getBeat(chapterTag: ChapterTag, beatTag: string): StoryBeat | undefined {
  return getChapterBeats(chapterTag).find(b => b.tag === beatTag);
}

export function getKillerPersonality(): BaseScript['killer']['personality'] {
  return getBaseScript().killer.personality;
}

export function getClueDef(clueTag: string): BaseScript['clues'][string] | undefined {
  return getBaseScript().clues[clueTag];
}

// ─── Puzzles ─────────────────────────────────────────────────────────────────

export function getPuzzleDefs(): PuzzleDef[] {
  if (!puzzleDefs) {
    const data = loadHjson<{ puzzles: PuzzleDef[] }>('config/last-logon/puzzles.hjson');
    puzzleDefs = data.puzzles;
    log.info({ count: puzzleDefs.length }, 'Puzzle definitions loaded');
  }
  return puzzleDefs;
}

export function getPuzzleDef(tag: string): PuzzleDef | undefined {
  return getPuzzleDefs().find(p => p.tag === tag);
}

// ─── NPCs ────────────────────────────────────────────────────────────────────

interface NPCConfig extends NPCTemplate {
  tag: string;
  initialMessages?: Array<{
    trigger: BeatTrigger;
    subject: string;
    body: string;
    bodyDe?: string;
  }>;
  oneLiners?: string[];
  oneLinersDE?: string[];
}

export function getNPCDefs(): NPCConfig[] {
  if (!npcDefs) {
    const data = loadHjson<{ npcs: NPCConfig[] }>('config/last-logon/npcs.hjson');
    npcDefs = data.npcs;
    log.info({ count: npcDefs.length }, 'NPC definitions loaded');
  }
  return npcDefs as NPCConfig[];
}

export function getNPCDef(tag: string): NPCConfig | undefined {
  return getNPCDefs().find(n => n.tag === tag);
}

// ─── Filesystem ──────────────────────────────────────────────────────────────

export function getFilesystemDef(): FilesystemDef {
  if (!filesystemDef) {
    filesystemDef = loadHjson<FilesystemDef>('config/last-logon/filesystem.hjson');
    log.info('Filesystem definition loaded');
  }
  return filesystemDef;
}

// ─── AI Prompts ──────────────────────────────────────────────────────────────

export function getAIPrompts(): Record<string, string> {
  if (!aiPrompts) {
    aiPrompts = loadHjson<Record<string, string>>('config/last-logon/ai-prompts.hjson');
    log.info('AI prompts loaded');
  }
  return aiPrompts;
}

export function getAIPrompt(key: string): string {
  const prompts = getAIPrompts();
  const prompt = prompts[key];
  if (!prompt) {
    throw new Error(`AI prompt "${key}" not found`);
  }
  return prompt;
}

// ─── Template interpolation ──────────────────────────────────────────────────

export function interpolateTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    return vars[key] !== undefined ? String(vars[key]) : match;
  });
}

// ─── Reset (for testing) ─────────────────────────────────────────────────────

export function resetCache(): void {
  baseScript = undefined;
  puzzleDefs = undefined;
  npcDefs = undefined;
  filesystemDef = undefined;
  aiPrompts = undefined;
}
