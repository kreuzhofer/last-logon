# Roadmap

This document tracks the implementation status of **Last Logon** — an AI-driven horror/mystery game that IS a retro BBS. Use this as the single source of truth when continuing development in new sessions.

---

## Vision

The entire BBS **is** the game world. Every player has a persistent game state that determines what they see in their own private BBS instance. The BBS starts feeling completely normal — horror creeps in gradually over multiple logins. The sysadmin (AXIOM) is secretly a serial killer who plays cat-and-mouse with players through messages, puzzles, and an adaptive AI persona powered by Claude.

Key pillars:
- **Per-player BBS world** — each player gets their own independent BBS with seeded community, messages, NPCs
- **Progressive feature unlocking** — BBS menu items appear/disappear based on story progression; killer can also *revoke* access
- **AI-driven killer persona** — Claude adapts mood, trust, suspicion per player; actively assesses player skill
- **Asynchronous gameplay** — killer responds over hours/days, not seconds; pulls you back via notifications
- **No two games alike** — AI personalizes the story per player; different clues, pacing, and interactions
- **The killer wants to be caught** — narcissistic, craves recognition for genius; gives worthy opponents a chance
- **Bilingual** — full English and German support
- **Multi-transport** — accessible via SSH and web browser (same experience)
- **Episodic** — designed for ongoing development; new puzzles/tools become available to active players mid-game
- **Cost-efficient AI** — scripted first beats, rolling conversation window, structured tool_use

---

## Implementation Status

### Legend
- Done = fully implemented and tested
- Partial = core exists but incomplete
- Planned = designed but not implemented
- Idea = discussed but no design yet

---

### Core BBS Infrastructure

| Component | Status | Notes |
|---|---|---|
| SSH server (ssh2) | Done | Port 2222, ed25519 host keys |
| WebSocket server (ws) | Done | Port 8080, xterm.js web client with landing page |
| Terminal abstraction | Done | readKey, readLine, readHotkey (supports arrow keys, PgUp/PgDn), cursor/color control |
| IConnection interface | Done | Transport-agnostic; SSHConnection and WebSocketConnection both implement it |
| ScreenFrame (80x25 UI) | Done | Fixed 80x25 for ANSI art compatibility, double-line border, breadcrumb, hotkey bar |
| Lightbar list component | Done | Reusable arrow-key/PgUp/PgDn selector used in messages, mail, area selection |
| ANSI colors & pipe codes | Done | `\|00`-`\|15` foreground, `\|16`-`\|23` background |
| Session & auth (argon2) | Done | Login, registration, password hashing, handle validation, input sanitization |
| Prisma/SQLite database | Done | 29 models, singleton client, per-user content scoping |
| HJSON configuration | Done | default.hjson, menus.hjson, message-areas.hjson, base-script.hjson, seed-data.hjson |
| Pino logging | Done | Per-module child loggers, uncaught exception/rejection handlers |
| Typed event bus | Done | user:login, message:new, node:activity events |
| Node allocation | Done | Max concurrent connections, node number tracking |
| Prisma migrations | Planned | Currently using `prisma db push`; should switch to `prisma migrate` |

### BBS Features

| Feature | Status | Notes |
|---|---|---|
| Message boards | Done | Classic lightbar message list (↑↓ PgUp/PgDn Enter), box-drawing reader header, conferences/areas |
| Personal mailbox | Done | [E] Mail — user-to-user private messages, NPC/killer messages delivered here |
| One-liner wall | Done | [O] with ghost user one-liners, per-player scoped |
| Who's online | Done | [W] active node display |
| Last callers | Done | [L] login history, per-player scoped with seeded NPC callers |
| User profiles | Done | [U] view/edit profile |
| System stats | Done | [S] per-player message/user counts |
| New message scan | Done | Automatic scan on login showing unread counts per area |
| Dynamic menu | Done | Menu items gated by PlayerGame.unlockedFeatures, changes per chapter |
| Per-player content | Done | Messages, one-liners, last callers, bulletins all scoped via playerGameId FK |
| Seed content | Done | 9 NPC users, ~40 messages, 15 one-liners, 20 last callers, 3 bulletins per player |
| Web client | Done | Landing page with "Connect via Browser" + SSH instructions, xterm.js, CRT effect |
| Bulletins | Partial | DB models + seed data exist, UI shows via seed only (no dedicated Bulletins screen yet) |
| Polls / voting booth | Partial | DB models exist (Poll, PollOption, PollVote), UI not implemented |
| File areas | Planned | DB model placeholder, no implementation |
| Teleconference / chat | Planned | Menu placeholder, no implementation |
| ANSI art viewer | Idea | `art/` directory exists, no display code |

### Game Integration (The BBS IS the Game)

| Component | Status | Notes |
|---|---|---|
| Game init on registration | Done | Language selection, PlayerGame creation, content seeding, prologue, ghost one-liners |
| Game hooks on login | Done | onPlayerLogin, connectionEffect, notifications, NPC triggers, auto-beats |
| Game hooks on logout | Done | onPlayerLogout via handleGoodbye + conn.onClose |
| Dynamic menu gating | Done | [T]erminal, [J]ournal, [F]iles appear based on chapter progression |
| Beat triggers on area visit | Done | Visiting BBS areas fires area_visit beat triggers |
| Chapter progression in main loop | Done | Checked after each menu action, with transition effects |
| Game screens as BBS modules | Done | terminalScreen, journalScreen, puzzleMenu exported from game/screens.ts |

### Game Engine — Core Systems

| Component | File | Status | Notes |
|---|---|---|---|
| Game types & interfaces | `src/game/game-types.ts` | Done | GamePhase, KillerMood, ChapterTag, BeatTrigger, PuzzleType, etc. |
| Base script loader | `src/game/base-script-loader.ts` | Done | HJSON config loading with caching, typed accessors |
| Game layer (state mgmt) | `src/game/game-layer.ts` | Done | CRUD, feature unlocking, clue/beat/puzzle tracking, chapter progression with branching |
| Game screens | `src/game/screens.ts` | Done | terminalScreen, journalScreen, puzzleMenu, processBeat, showChapterTransition |
| Content seeder | `src/game/content-seeder.ts` | Done | Per-player seeding on registration, NPC users shared across games |
| Narrative renderer | `src/game/narrative.ts` | Done | Typewriter, glitch, connection/disconnect effects, chat UI, journal |
| AI engine | `src/game/ai-engine.ts` | Done | getKillerResponse, generateAsyncMessage, generatePuzzleHint, evaluateFreeFormAnswer, summarizeConversation |
| Puzzle engine | `src/game/puzzles/puzzle-engine.ts` | Done | 6 validators (exact, fuzzy, rot13, numeric, contains, AI), hint system, attempt tracking |
| Hidden terminal | `src/game/hidden-terminal.ts` | Done | ls, cd, cat, grep, pwd, whoami, help, clear, exit; clue-gated visibility |
| Message bridge | `src/game/message-bridge.ts` | Done | Game→BBS message injection, NPC trigger checking, ghost one-liners; per-player scoped |
| Background scheduler | `src/game/scheduler.ts` | Done | Hourly inactivity check, 3-tier urgency, AI message generation |

### Game Content — Story & Config

| Content | File | Status | Notes |
|---|---|---|---|
| Killer personality | `config/base-script.hjson` | Done | Traits, motivation, style, communication patterns |
| Prologue chapter | `config/base-script.hjson` | Done | 3 beats (first_login, npc_welcome, odd_oneliner), scripted text EN/DE |
| Chapter 1 | `config/base-script.hjson` | Done | 4 beats, unlocks bulletins/lastCallers |
| Chapter 2 | `config/base-script.hjson` | Done | 4 beats, killer first contact, unlocks hiddenTerminal + terminal |
| Chapter 3 | `config/base-script.hjson` | Done | 5 beats, encrypted logs, server tracing |
| Chapter 4 | `config/base-script.hjson` | Done | 4 beats, evidence assembly, branching path |
| Chapter 5a: Caught | `config/base-script.hjson` | Done | 2 beats, confrontation + resolution, scripted ending EN/DE |
| Chapter 5b: Escaped | `config/base-script.hjson` | Done | 1 beat, cliffhanger ending, scripted text EN/DE |
| 8 clue definitions | `config/base-script.hjson` | Done | Evidence weights 1-10, EN/DE descriptions |
| 4 NPC templates | `config/base-script.hjson` | Done | NIGHTOWL, SIGNAL_LOST, D_COLE, ECHO_7 |
| Seed community data | `config/last-logon/seed-data.hjson` | Done | 9 NPC users, 39 messages, 15 one-liners, 20 last callers, 3 bulletins |

### Game Content — Puzzles

| Puzzle | Tag | Type | Validator | Chapter | Status |
|---|---|---|---|---|---|
| ROT13 cipher | `cipher_01` | cipher | rot13 | ch1 | Done |
| Map riddle | `riddle_01` | riddle | fuzzy | ch2 | Done |
| Decrypt logs | `decrypt_logs` | logic | ai | ch3 | Done |
| Trace server | `trace_server` | exploration | exact | ch3 | Done |
| Final trace | `final_trace` | exploration | contains | ch4 | Done |
| Assemble evidence | `assemble_evidence` | logic | ai | ch4 | Done |

### Game Content — NPCs

| NPC | Handle | Role | Trigger | Status |
|---|---|---|---|---|
| Regular user | NIGHTOWL | fellow_user | login_count >= 2 | Done — initial message defined |
| Worried user | SIGNAL_LOST | fellow_user | clue: news_disappearances | Done — initial message defined |
| Investigator | D_COLE | investigator | clue: hidden_system_access | Done — initial message defined |
| Ghost user | ECHO_7 | ghost | (one-liners injected at game start) | Done — 6 one-liners EN/DE |
| NPC AI responses | — | — | — | **Not implemented** — NPCs send hardcoded initial messages only; no dynamic AI conversation |

### Testing

| Test File | Status | Coverage |
|---|---|---|
| `tests/game/base-script-loader.test.ts` | Done | Config loading, chapters, beats, clues, puzzles, NPCs, filesystem, AI prompts, interpolation |
| `tests/game/puzzle-engine.test.ts` | Done | All 6 validation strategies, NaN guards |
| `tests/game/game-layer.test.ts` | Done | Feature unlocking, clue/beat/puzzle state, all beat trigger types |
| `tests/game/hidden-terminal.test.ts` | Done | Path resolution, filesystem navigation, node visibility, clue gating |
| `tests/auth/auth-service.test.ts` | Done | Hashing, validation, registration with sanitization, login/logout, user lookups |
| `tests/messages/message-service.test.ts` | Done | Seeding, CRUD, unread tracking, per-player scoping |
| AI engine tests (mocked) | **Not written** | getKillerResponse, generateAsyncMessage, summarizeConversation with mocked Vercel AI SDK |
| Message bridge tests | **Not written** | sendKillerMessage, NPC trigger checking (needs DB mocking) |
| Integration / E2E tests | **Not written** | Full game flow from init through chapter progression |

**Current: 143 tests passing across 6 test files.**

---

## Known Issues

1. **TypeScript strict mode errors** — `tsc --noEmit` shows errors in ai-engine.ts (Vercel AI SDK API mismatches) and hjson type declarations. Does not affect runtime via tsx.

2. **NPCs are one-directional** — The `npcSystemPrompt` template exists but no `generateNPCResponse()` function is implemented. NPCs send hardcoded initial messages only.

3. **Prisma uses db push, not migrations** — Should switch to `prisma migrate` for production-safe schema changes that preserve data.

4. **Bulletins screen not implemented** — Bulletin data is seeded per-player but there's no dedicated [B] Bulletins screen. Currently "Coming Soon".

5. **Game progression not fully play-tested** — The complete flow from prologue through all chapters to either ending has not been tested end-to-end with a real player and live AI.

---

## Backlog — Prioritized

### P0 — Must Fix (Blocks Full Playability)

- [ ] **Play-test prologue through chapter 1** with real AI
  - Verify beat triggers fire correctly at each stage
  - Verify NPC messages appear at the right time
  - Verify cipher puzzle is solvable
  - Test chapter 1 → chapter 2 progression

- [ ] **Switch to Prisma migrations** for production-safe schema changes
  - `prisma migrate dev` for development
  - `prisma migrate deploy` for production
  - Never reset DB without explicit user permission

### P1 — The Living BBS (Next Priority)

- [ ] **5x seed content** — Expand from ~40 to ~200 messages across all boards
  - Deeper retro computing threads, more BBS nostalgia, richer NPC personalities
  - Date seed messages relative to player's registration (not absolute dates)
  - More message areas with active discussions
  - Each NPC should have a distinct voice and posting style

- [ ] **Convert story beats to natural messages** — No more cutscene interruptions
  - "People disappeared" beats → personal message from a worried NPC
  - "Police investigation" → post in local.general from an NPC who saw something
  - All story progression delivered through BBS content, not splash screens
  - Player discovers the story by reading the BBS, not being shown it

- [ ] **Real-time notification system** — New mail alerts during BBS use
  - Bottom bar flashes `[NEW MAIL]` when personal message arrives
  - Hotkey (e.g., `!`) to read immediately or dismiss
  - Blinking `[*]` indicator in top-right corner of ScreenFrame until mail is read
  - Replaces the login-only new message scan

- [ ] **Responsive NPC AI posting** — NPCs respond to player posts in near-real-time
  - When player posts in a board, NPCs may respond within 5-30 minutes (randomized)
  - Activity peaks during evening/night hours (server time = user time)
  - Each NPC has personality constraints (NIGHTOWL posts late, BYTE_RUNNER is enthusiastic, DARK_MATTER is philosophical)
  - Use Haiku for ambient NPC posts (cheap), Sonnet for story-critical moments
  - Scheduler checks every 5-15 minutes during active hours (not hourly)

- [ ] **Story orchestrator** — AI-driven narrative coherence
  - Tracks ongoing discussion threads the AI is managing
  - Knows what hints have been dropped, what NPCs have said, what the player has read
  - Feeds context to NPC AI so responses build on each other
  - Posts become subtly more unsettling as chapters progress
  - Normal retro discussion threads start having weird tangents about system glitches and disappearances

- [ ] **Bulletins screen** — Implement [B] Bulletins UI
  - Display per-player bulletins with pipe code rendering
  - Game injects new bulletins as story progresses (strange announcements, news of disappearances)

### P2 — Polish & Depth

- [ ] **NPC AI conversation responses** — Players can reply to NPC messages and get AI-generated replies
  - Use existing `npcSystemPrompt` template
  - Wire into mail system (player writes reply → AI generates NPC response)

- [ ] **ANSI art** — Welcome screens, chapter transitions, killer messages
  - `art/` directory exists but is empty
  - Classic BBS aesthetic, essential for the retro feel

- [ ] **Polls / voting booth UI** — DB models exist, need screen implementation
  - Game can use polls as story devices (rigged polls, suspicious results)

- [ ] **Adaptive difficulty system** — Killer assesses player skill and adjusts challenge accordingly
  - Track solve speed, hint usage, attempt counts, response quality across puzzles
  - Feed skill profile into killer AI prompt so the killer *actively gauges* the player
  - If player is too good → harder puzzles, fewer hints, killer gets more guarded
  - If player struggles → killer drops more breadcrumbs (ego demands an audience)

- [ ] **Sound effects** via terminal bell (`\x07`) for jump scares

- [ ] **Feature revocation** — Killer can *remove* previously unlocked features as punishment

- [ ] **Hints earned through tasks** — Players must earn hints by doing favors for the killer

- [ ] **ASCII mini-games with embedded clues** — Classic terminal games where clues are hidden in gameplay

- [ ] **AI engine tests** — Mock Vercel AI SDK, test all 5 AI functions

- [ ] **Integration tests** — Full game flow from init through chapter progression

- [ ] **Fix TypeScript strict errors** in ai-engine.ts
  - No AI needed for basic version — pull from predefined pool in HJSON config

### P3 — Future Episodes & Extensions

- [ ] **Episode 2 content** — Continue the story after Chapter 5
  - New chapters, puzzles, NPCs
  - Deeper filesystem with more hidden areas
  - New killer personality evolution based on Episode 1 outcome
  - Episodic releases — players get notified when new episode drops

- [ ] **Web search integration** — Killer "plants evidence" on real websites
  - AI searches the web for real content that fits the narrative
  - Player must leave the BBS and search Google/Wikipedia
  - Blurs the line between game and reality

- [ ] **Messenger notifications** — Pull players back via their preferred messaging app
  - Telegram, Signal, or other free-to-integrate messengers
  - Killer sends taunts, reminders, time-pressure messages outside the BBS

- [ ] **Email bridge** — Email notifications for game events

- [ ] **File areas** — BBS file download/upload system with planted evidence files

- [ ] **Teleconference / real-time chat** — Multi-user chat room with killer/NPC appearances

- [ ] **Multi-player co-op mode** — Groups of 3-4 collaborate to catch the killer
  - Communication over the BBS is risky — killer can read messages between players

- [ ] **Sysop dashboard** — Web UI for monitoring active games, AI costs, story states

---

## Architecture Notes for Future Sessions

### ESM Module System
All imports use `.js` extensions even though source is `.ts`. TypeScript configured with `"module": "ESNext"` and `"moduleResolution": "bundler"`.

### Per-Player Content Scoping
All BBS content (messages, one-liners, last callers, bulletins) is scoped via `playerGameId` FK. Each player sees their own independent BBS world. NPC users (AXIOM, NIGHTOWL, etc.) are shared across games with `accessLevel: 0` (locked). Structural data (conferences, areas) is global.

### Transport Architecture
`IConnection` interface in `src/server/connection.ts` is transport-agnostic. `SSHConnection` and `WebSocketConnection` both implement it. The BBS code doesn't know which transport is being used. WebSocket uses JSON protocol: `{type: 'output'|'input'|'resize', data?, cols?, rows?}`.

### Database Management
Use `prisma migrate` for schema changes (not `db push`). Never reset the database without explicit permission — game progress must be preserved.

### Adding a New Puzzle
1. Add definition to `config/last-logon/puzzles.hjson`
2. Reference puzzle tag in a beat's effects in `config/base-script.hjson`
3. Validation is automatic based on `validator` type
4. Tests in `tests/game/puzzle-engine.test.ts` cover all validator types

### Adding a New NPC
1. Add template to `config/last-logon/npcs.hjson`
2. Add NPC template reference to `config/base-script.hjson` npcTemplates section
3. Message bridge auto-creates NPCs and sends initial messages based on triggers

### Adding a New Chapter
1. Add chapter definition to `config/base-script.hjson` with beats, features, progression
2. Add `ChapterTag` union member in `game-types.ts`
3. Add phase mapping in `getPhaseForChapter()` in `game-layer.ts`
4. Add scripted text for key beats (EN/DE)

### How AI Calls Work
1. Player types in terminal screen → `getKillerResponse()` called
2. Last 15 messages loaded from `GameConversation` table
3. System prompt built from template + personality + story context
4. Forced `tool_use` with `respond_to_player` tool ensures structured response
5. Response effects (mood, trust, suspicion, clues, unlocks) applied via `applyKillerResponseEffects()`
6. If 10+ messages, `summarizeConversation()` compresses older messages

### Config Loading Pattern
All HJSON configs are loaded lazily and cached. Call `resetCache()` in tests. Access via typed getters in `base-script-loader.ts`.

### Key Environment Variables
- `DATABASE_URL` — SQLite path (required)
- `ANTHROPIC_API_KEY` — Claude API key (required for AI features, validated at startup)
- `LAST_LOGON_AI_MODEL` — Override AI model (optional, defaults to config value)

---

*Last updated: 2026-03-29*
