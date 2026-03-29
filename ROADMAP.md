# Roadmap

This document tracks the implementation status of **Last Logon** — an AI-driven horror/mystery game embedded in a retro BBS over SSH. Use this as the single source of truth when continuing development in new sessions.

---

## Vision

The entire BBS **is** the game world. Every player has a persistent game state that determines what they see. The BBS starts feeling completely normal — horror creeps in gradually over multiple logins. The sysadmin (AXIOM) is secretly a serial killer who plays cat-and-mouse with players through messages, puzzles, and an adaptive AI persona powered by Claude.

Key pillars:
- **Persistent per-player game state** — each login continues the story
- **Progressive feature unlocking** — BBS features unlock as the story advances
- **AI-driven killer persona** — Claude adapts mood, trust, suspicion per player
- **Asynchronous gameplay** — killer responds over hours/days, not seconds
- **Bilingual** — full English and German support
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
| Terminal abstraction | Done | readKey, readLine, readHotkey, cursor/color control |
| ScreenFrame (80x25 UI) | Done | Double-line border, breadcrumb, hotkey bar |
| ANSI colors & pipe codes | Done | `\|00`-`\|15` foreground, `\|16`-`\|23` background |
| Session & auth (argon2) | Done | Login, registration, password hashing |
| Prisma/SQLite database | Done | 23 models, singleton client |
| HJSON configuration | Done | default.hjson, menus.hjson, message-areas.hjson |
| Pino logging | Done | Per-module child loggers |
| Typed event bus | Done | user:login, message:new, node:activity events |
| Node allocation | Done | Max concurrent connections, node number tracking |
| WebSocket transport | Planned | Config exists (`websocket: enabled: false`), no implementation |

### BBS Features

| Feature | Status | Notes |
|---|---|---|
| Message boards | Done | Conferences, areas, read/write, threading |
| One-liner wall | Done | Seeded with ghost user one-liners by game |
| Who's online | Done | Active node display |
| Last callers | Done | Login history |
| User profiles | Done | View/edit profile |
| Bulletins | Done | System bulletins |
| Sysop account creation | Done | CLI script |
| Demo data seeding | Done | CLI script |
| Menu engine | Partial | Config-driven definitions exist, but most flow is hardcoded in bbs.ts |
| Polls / voting booth | Partial | DB models exist (Poll, PollOption, PollVote), UI not implemented |
| Door games framework | Partial | Last Logon works as a door, but no generic framework for other doors |
| File areas | Planned | DB model placeholder, no implementation |
| Teleconference / chat | Planned | Menu placeholder, no implementation |
| Telegram bridge | Idea | Mentioned in original design, no code or config |
| Email bridge | Idea | Mentioned in original design, no code or config |
| ANSI art viewer | Idea | `art/` directory exists, no display code |

### Game Engine — Core Systems

| Component | File | Status | Notes |
|---|---|---|---|
| Game types & interfaces | `src/game/game-types.ts` | Done | GamePhase, KillerMood, ChapterTag, BeatTrigger, PuzzleType, etc. |
| Base script loader | `src/game/base-script-loader.ts` | Done | HJSON config loading with caching, typed accessors |
| Game layer (state mgmt) | `src/game/game-layer.ts` | Done | CRUD, feature unlocking, clue/beat/puzzle tracking, chapter progression |
| Game entry & menu | `src/game/index.ts` | Done | Dynamic hotkeys, feature gating, beat processing, chapter transitions |
| Game initialization | `src/game/game-init.ts` | Done | Language selection, prologue, ghost one-liner injection |
| Narrative renderer | `src/game/narrative.ts` | Done | Typewriter, glitch, connection/disconnect effects, chat UI, journal |
| AI engine | `src/game/ai-engine.ts` | Done | getKillerResponse, generateAsyncMessage, generatePuzzleHint, evaluateFreeFormAnswer, summarizeConversation |
| Puzzle engine | `src/game/puzzles/puzzle-engine.ts` | Done | 6 validators (exact, fuzzy, rot13, numeric, contains, AI), hint system, attempt tracking |
| Hidden terminal | `src/game/hidden-terminal.ts` | Done | ls, cd, cat, grep, pwd, whoami, help, clear, exit; clue-gated visibility |
| Message bridge | `src/game/message-bridge.ts` | Done | Game→BBS message injection, NPC trigger checking, ghost one-liners |
| Background scheduler | `src/game/scheduler.ts` | Done | Hourly inactivity check, 3-tier urgency, AI message generation |
| BBS integration | `src/core/bbs.ts` (modified) | Done | Door menu routing, login hooks, notification display |
| Startup integration | `src/index.ts` (modified) | Done | Scheduler start/stop on boot/shutdown |

### Game Content — Story & Config

| Content | File | Status | Notes |
|---|---|---|---|
| Killer personality | `config/base-script.hjson` | Done | Traits, motivation, style, communication patterns |
| Prologue chapter | `config/base-script.hjson` | Done | 3 beats (first_login, npc_welcome, odd_oneliner), scripted text EN/DE |
| Chapter 1 | `config/base-script.hjson` | Done | 4 beats, unlocks bulletins/lastCallers |
| Chapter 2 | `config/base-script.hjson` | Done | 4 beats, killer first contact, unlocks hiddenTerminal |
| Chapter 3 | `config/base-script.hjson` | Done | 5 beats, encrypted logs, server tracing |
| Chapter 4 | `config/base-script.hjson` | Done | 4 beats, evidence assembly, branching path |
| Chapter 5a: Caught | `config/base-script.hjson` | Done | 2 beats, confrontation + resolution, scripted ending EN/DE |
| Chapter 5b: Escaped | `config/base-script.hjson` | Done | 1 beat, cliffhanger ending, scripted text EN/DE |
| 8 clue definitions | `config/base-script.hjson` | Done | Evidence weights 1-10, EN/DE descriptions |
| 4 NPC templates | `config/base-script.hjson` | Done | NIGHTOWL, SIGNAL_LOST, D_COLE, ECHO_7 |

### Game Content — Puzzles

| Puzzle | Tag | Type | Validator | Chapter | Status |
|---|---|---|---|---|---|
| ROT13 cipher | `cipher_01` | cipher | rot13 | ch1 | Done |
| Map riddle | `riddle_01` | riddle | fuzzy | ch2 | Done |
| Decrypt logs | `decrypt_logs` | logic | ai | ch3 | Done |
| Trace server | `trace_server` | exploration | exact | ch3 | Done |
| Assemble evidence | `assemble_evidence` | logic | ai | ch4 | Done |
| Final trace | `final_trace` | — | — | ch4 | **Missing** — referenced in base-script.hjson Chapter 4 beat but no puzzle definition exists |

### Game Content — NPCs

| NPC | Handle | Role | Trigger | Status |
|---|---|---|---|---|
| Regular user | NIGHTOWL | fellow_user | login_count >= 2 | Done — initial message defined |
| Worried user | SIGNAL_LOST | fellow_user | clue: news_disappearances | Done — initial message defined |
| Investigator | D_COLE | investigator | clue: hidden_system_access | Done — initial message defined |
| Ghost user | ECHO_7 | ghost | (one-liners injected at game start) | Done — 6 one-liners EN/DE |
| NPC AI responses | — | — | — | **Not implemented** — NPCs send hardcoded initial messages only; no dynamic AI conversation |

### Game Content — Pseudo-Filesystem

| Path | Status | Notes |
|---|---|---|
| `/system/motd.txt` | Done | BBS welcome message |
| `/system/users.db` | Done | User database excerpt |
| `/system/logs/access.log` | Done | Suspicious log entries |
| `/system/logs/trace/` | Done | Clue-gated (requires `server_region`) |
| `/system/logs/trace/hop_1.log` | Done | Network trace hop |
| `/system/logs/trace/hop_2.log` | Done | Network trace hop |
| `/system/logs/trace/final_hop.log` | Done | Reveals `server_location` clue |
| `/system/private/` | Done | Hidden, requires `hidden_system_access` |
| `/system/private/notes.txt` | Done | Reveals `victim_details` clue |
| `/system/private/schedule.dat` | Done | Maintenance schedule hints |
| `/home/axiom/.profile` | Done | Killer's home dir with suspicious alias |
| `/tmp/` | Done | Empty temp directory |

### Game Content — AI Prompts

| Template | Status | Notes |
|---|---|---|
| killerSystemPrompt | Done | 40 variable placeholders, 10 in-character rules |
| npcSystemPrompt | Done | Template exists but **not called** — NPC AI responses not implemented |
| puzzleHintPrompt | Done | Used by generatePuzzleHint() |
| summarizePrompt | Done | Used by summarizeConversation() |
| evaluateAnswerPrompt | Done | Used by evaluateFreeFormAnswer() |

### Testing

| Test File | Status | Coverage |
|---|---|---|
| `tests/game/base-script-loader.test.ts` | Done | Config loading, chapters, beats, clues, puzzles, NPCs, filesystem, AI prompts, interpolation |
| `tests/game/puzzle-engine.test.ts` | Done | All 6 validation strategies |
| `tests/game/game-layer.test.ts` | Done | Feature unlocking, clue/beat/puzzle state, all beat trigger types |
| `tests/game/hidden-terminal.test.ts` | Done | Path resolution, filesystem navigation, node visibility, clue gating |
| `scripts/test-game.ts` | Done | Interactive CLI tester for puzzles, filesystem, NPCs, prompts, chapters |
| AI engine tests (mocked) | **Not written** | getKillerResponse, generateAsyncMessage, summarizeConversation with mocked Vercel AI SDK |
| Message bridge tests | **Not written** | sendKillerMessage, NPC trigger checking (needs DB mocking) |
| Narrative tests | **Not written** | Typewriter/effect functions (needs terminal mocking) |
| Integration / E2E tests | **Not written** | Full game flow from init through chapter progression |

**Current: 81 tests passing across 4 test files.**

---

## Known Issues

1. **Missing `final_trace` puzzle definition** — Chapter 4 beat references it but no definition exists in `config/last-logon/puzzles.hjson`. Players reaching Chapter 4 will hit a "Puzzle definition not found" error.

2. **TypeScript strict mode errors** — `tsc --noEmit` shows ~35 errors mostly in pre-existing BBS code (missing awaits in bbs.ts, hjson type declarations, Vercel AI SDK API mismatches in ai-engine.ts). Does not affect runtime via tsx.

3. **NPCs are one-directional** — The `npcSystemPrompt` template exists but no `generateNPCResponse()` function is implemented. NPCs send hardcoded initial messages only.

4. **Chapter 4 branching** — The `alternateCondition` for choosing between caught/escaped endings is defined in the script but the branching logic in `checkChapterProgression()` only looks at `progression.advanceTo` (single target). Needs conditional branching based on suspicion level or flags.

5. **Menu engine underused** — `config/menus.hjson` defines menu structures but actual flow is hardcoded in `bbs.ts`. The menu engine in `src/menus/menu-engine.ts` is loaded but not fully utilized.

---

## Backlog — Prioritized

### P0 — Must Fix (Blocks Gameplay)

- [ ] **Add `final_trace` puzzle definition** to `config/last-logon/puzzles.hjson`
  - Type: exploration or logic (traces killer's server location)
  - Should gate on `server_region` clue
  - Validator: exact or contains
  - Reward: reveals `server_location` clue

- [ ] **Fix Chapter 4→5 branching logic** in `game-layer.ts`
  - `checkChapterProgression()` needs to evaluate `alternateCondition` from base-script
  - Branch to `chapter5_caught` if suspicion > threshold + evidence assembled
  - Branch to `chapter5_escaped` otherwise
  - Currently always goes to single `advanceTo` target

### P1 — Should Have (Enriches Experience)

- [ ] **NPC AI responses** — Implement `generateNPCResponse()` in ai-engine.ts
  - Use existing `npcSystemPrompt` template
  - Allow players to reply to NPC messages and get AI-generated responses
  - Wire into message system (player writes reply → AI generates NPC response)

- [ ] **AI engine tests** — Mock Vercel AI SDK, test all 5 AI functions
  - Test structured tool_use parsing
  - Test fallback responses on API failure
  - Test conversation window management (15-message limit)
  - Test summarization trigger (10+ messages)

- [ ] **Message bridge tests** — Test with mocked Prisma client
  - sendKillerMessage, sendNPCMessage
  - checkAndSendNPCMessages trigger evaluation
  - injectGhostOneLiners

- [ ] **Integration tests** — Full game flow
  - Init → prologue → chapter progression → puzzle solving → ending
  - Test with mocked terminal/session

- [ ] **Polls / voting booth UI** — DB models exist, need screen implementation
  - Game can use polls as story devices (rigged polls, suspicious results)

### P2 — Nice to Have (Polish)

- [ ] **Fix TypeScript strict errors** in ai-engine.ts
  - `maxTokens` → check Vercel AI SDK v6 API for correct property name
  - Tool result type assertion for `respond_to_player`
  - Add hjson type declaration file

- [ ] **Adaptive difficulty system** — Adjust puzzle difficulty and hint frequency based on player skill assessment
  - Track solve speed, hint usage, attempt counts across puzzles
  - Feed skill profile into killer AI prompt for adaptive responses
  - Planned in original design, not implemented

- [ ] **Mini-games** within the BBS
  - Planned: Classic BBS door games (Tradewars-style, trivia) that the killer corrupts
  - Could be simple terminal games that get "infected" as story progresses

- [ ] **Door games framework** — Generic framework for plugging in other door games
  - Currently only Last Logon works as a door
  - Need: game registration, dropfile generation, state management

- [ ] **ANSI art** — Welcome screens, chapter transitions, killer messages with ASCII art
  - `art/` directory exists but is empty
  - Classic BBS aesthetic enhancement

- [ ] **Sound effects** via terminal bell (`\x07`) for jump scares
  - Killer messages, glitch effects, chapter transitions

### P3 — Future Episodes & Extensions

- [ ] **Episode 2 content** — Continue the story after Chapter 5
  - New chapters, puzzles, NPCs
  - Deeper filesystem with more hidden areas
  - New killer personality evolution based on Episode 1 outcome

- [ ] **WebSocket transport** — Browser-based BBS access
  - Config exists (`servers.websocket`), needs implementation
  - Would enable web-based terminal emulator frontend
  - `IConnection` interface is already transport-agnostic

- [ ] **Telegram bridge** — Receive killer messages as Telegram notifications
  - Pull players back into the game asynchronously
  - Could send puzzle hints, story beats, killer taunts

- [ ] **Email bridge** — Email notifications for game events
  - "You have a new message on The Neon Underground"
  - Killer could "email" players directly

- [ ] **File areas** — BBS file download/upload system
  - Game could plant evidence files in file areas
  - Players discover incriminating uploads

- [ ] **Teleconference / real-time chat** — Multi-user chat room
  - Game could have killer appear in chat
  - NPCs could be present in real-time
  - Ghost user could glitch through chat

- [ ] **Multi-player story interactions** — Players affecting each other's stories
  - Killer references other players' actions
  - Shared evidence board
  - Cooperative puzzle solving

- [ ] **Sysop dashboard** — Web UI for monitoring active games
  - View player progress, AI costs, story states
  - Override game state for debugging
  - View AI conversation logs

---

## Architecture Notes for Future Sessions

### ESM Module System
All imports use `.js` extensions even though source is `.ts`. TypeScript configured with `"module": "ESNext"` and `"moduleResolution": "bundler"`.

### Adding a New Puzzle
1. Add definition to `config/last-logon/puzzles.hjson`
2. Reference puzzle tag in a beat's effects in `config/base-script.hjson`
3. Validation is automatic based on `validator` type
4. Tests in `tests/game/puzzle-engine.test.ts` cover all validator types

### Adding a New NPC
1. Add template to `config/last-logon/npcs.hjson` (tag, handle, role, personality, initialMessages with triggers)
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
- `ANTHROPIC_API_KEY` — Claude API key (required for AI features)
- `LAST_LOGON_AI_MODEL` — Override AI model (optional, defaults to config value)

---

*Last updated: 2026-03-29*
