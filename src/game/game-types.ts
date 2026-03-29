// Last Logon - Game type definitions
// All shared types and interfaces for the AI-driven horror game

// ─── Story Progression ──────────────────────────────────────────────────────

export type GamePhase =
  | 'prologue'       // First logins, everything seems normal
  | 'suspicious'     // Strange things start happening
  | 'aware'          // Player knows something is wrong
  | 'hunted'         // Killer is actively engaging
  | 'endgame';       // Final confrontation

export type KillerMood =
  | 'charming'       // Friendly, helpful sysop persona
  | 'playful'        // Teasing, dropping hints
  | 'condescending'  // Player is boring/slow
  | 'irritated'      // Player is ignoring or annoying
  | 'threatening'    // Direct threats
  | 'impressed'      // Player is worthy
  | 'manic';         // Unhinged, dangerous

export type ChapterTag =
  | 'prologue'
  | 'chapter1'
  | 'chapter2'
  | 'chapter3'
  | 'chapter4'
  | 'chapter5_caught'
  | 'chapter5_escaped';

// ─── Game State (stored as JSON in PlayerGame fields) ────────────────────────

export interface PlayerFlags {
  [key: string]: boolean | string | number;
}

export interface ClueInfo {
  tag: string;
  foundAt: string;        // ISO datetime
  chapter: ChapterTag;
  description?: string;
}

export interface StoryLogEntry {
  timestamp: string;      // ISO datetime
  type: 'beat' | 'clue' | 'puzzle' | 'npc' | 'unlock' | 'message' | 'login';
  summary: string;
  details?: Record<string, unknown>;
}

// ─── AI Response Structures ──────────────────────────────────────────────────

export interface KillerResponse {
  text: string;              // Display text (may contain pipe codes)
  mood: KillerMood;          // Updated killer mood
  beatTriggered?: string;    // Story beat tag if triggered
  clueRevealed?: string;     // Clue tag if embedded in response
  unlocks?: string[];        // BBS features to unlock
  trustDelta?: number;       // Change to killer trust (-100 to +100)
  suspicionDelta?: number;   // Change to killer suspicion (0-100)
}

export interface NPCResponse {
  text: string;
  relationship?: string;     // Updated relationship status
  clueRevealed?: string;
}

// ─── Base Script Types ───────────────────────────────────────────────────────

export interface KillerPersonality {
  traits: string[];
  motivation: string;
  style: string;
  communication: string;
}

export interface BeatTrigger {
  type: 'auto' | 'player_action' | 'interaction_count' | 'area_visit' | 'clue_found' | 'puzzle_solved' | 'login_count';
  action?: string;
  area?: string;
  clue?: string;
  puzzle?: string;
  min?: number;
}

export interface StoryBeat {
  tag: string;
  trigger: BeatTrigger | 'auto';
  description: string;
  scriptedText?: string;      // Pre-scripted text (no AI needed)
  scriptedTextDe?: string;    // German version
  puzzle?: string;            // Puzzle to present
  clue?: string;              // Clue to reveal
  unlocks?: string[];         // Features to unlock
  killerMood?: KillerMood;
  required: boolean;          // Must be completed for chapter progression
  npc?: string;               // NPC involved
}

export interface ChapterDef {
  title: string;
  titleDe?: string;
  description: string;
  descriptionDe?: string;
  beats: StoryBeat[];
  features: string[];         // Available BBS features in this chapter
  progression: {
    advanceTo: ChapterTag;
    requires: string[];       // Beat tags required
    minLogins?: number;
    alternateAdvanceTo?: ChapterTag;
    alternateCondition?: string;
  };
}

export interface ClueDef {
  description: string;
  descriptionDe?: string;
  evidenceWeight: number;     // 1-10
}

export interface BaseScript {
  meta: {
    title: string;
    version: string;
    totalChapters: number;
  };
  killer: {
    personality: KillerPersonality;
  };
  chapters: Record<ChapterTag, ChapterDef>;
  clues: Record<string, ClueDef>;
  npcTemplates: Record<string, NPCTemplate>;
}

// ─── NPC Types ───────────────────────────────────────────────────────────────

export interface NPCTemplate {
  handle: string;
  role: 'fellow_user' | 'investigator' | 'victim' | 'suspect' | 'ghost';
  personality: string;
  personalityDe?: string;
  arc: string;
  firstContactTrigger?: BeatTrigger;
}

export type NPCStatus = 'active' | 'disappeared' | 'dead' | 'arrested';
export type NPCRelationship = 'stranger' | 'acquaintance' | 'ally' | 'suspicious' | 'hostile';

// ─── Puzzle Types ────────────────────────────────────────────────────────────

export type PuzzleType = 'cipher' | 'riddle' | 'exploration' | 'logic' | 'pattern';
export type PuzzleDifficulty = 'easy' | 'medium' | 'hard';

export interface PuzzleDef {
  tag: string;
  type: PuzzleType;
  chapter: ChapterTag;
  difficulty: PuzzleDifficulty;
  presentation: string;       // Display text with pipe codes
  presentationDe?: string;
  validator: 'exact' | 'fuzzy' | 'rot13' | 'numeric' | 'contains' | 'ai';
  answers?: string[];         // Acceptable answers (for deterministic validation)
  fuzzyTokens?: string[];     // Tokens that must appear in answer
  maxAttempts: number;
  hints: string[];
  hintsDe?: string[];
  onSolve: {
    clue?: string;
    killerResponse?: KillerMood;
    trustDelta?: number;
    unlocks?: string[];
  };
  onFail: {
    killerResponse?: KillerMood;
    trustDelta?: number;
  };
}

export interface PuzzleInstance {
  puzzleTag: string;
  generatedText?: string;     // AI-generated puzzle text
  generatedAnswer?: string;   // AI-generated answer (for AI-validated puzzles)
  attempts: number;
  hintsUsed: number;
  solved: boolean;
}

// ─── Filesystem Types ────────────────────────────────────────────────────────

export interface FSNode {
  name: string;
  type: 'file' | 'directory';
  content?: string;           // File content (with pipe codes)
  contentDe?: string;
  children?: FSNode[];
  hidden?: boolean;           // Only visible after certain conditions
  requiredClue?: string;      // Clue needed to see this node
  revealsClue?: string;       // Clue revealed by reading this file
}

export interface FilesystemDef {
  root: FSNode;
}

// ─── Game Menu & UI ──────────────────────────────────────────────────────────

export interface GameMenuItem {
  key: string;
  label: string;
  labelDe?: string;
  area: string;
  requiredFeature?: string;   // Must be in unlockedFeatures
}

// ─── Conversation Context (for AI calls) ─────────────────────────────────────

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface StoryContext {
  chapter: ChapterTag;
  phase: GamePhase;
  killerMood: KillerMood;
  killerAlias: string;
  language: string;
  cluesFound: string[];
  puzzlesSolved: string[];
  unlockedFeatures: string[];
  suspicionLevel: number;
  totalSessions: number;
  recentEvents: StoryLogEntry[];
  storySummary: string;
  completedBeats: string[];
  activeNPCs: Array<{ handle: string; role: string; relationship: string; status: string }>;
}

// ─── Config Types ────────────────────────────────────────────────────────────

export interface GameConfig {
  enabled: boolean;
  aiModel: string;
  maxAiCallsPerMinute: number;
  killerResponseDelayMin: number;  // seconds
  killerResponseDelayMax: number;  // seconds
  inactivityReminderHours: number;
}
