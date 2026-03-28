# Last Logon

A retro BBS (Bulletin Board System) over SSH with an AI-driven horror/mystery game embedded into it. The sysadmin is a serial killer — and the entire BBS is the game world.

Built with TypeScript, Prisma/SQLite, and the Vercel AI SDK (Anthropic Claude).

```
╔══════════════════════════════════════════════════════════════╗
║  "Where the 90s never ended"                                ║
║                                                              ║
║  The Neon Underground BBS — ssh localhost -p 2222            ║
╚══════════════════════════════════════════════════════════════╝
```

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Environment Variables](#environment-variables)
- [Configuration](#configuration)
- [Running the BBS](#running-the-bbs)
- [Connecting](#connecting)
- [The Game: Last Logon](#the-game-last-logon)
- [Testing](#testing)
- [Project Structure](#project-structure)
- [Database](#database)
- [Scripts Reference](#scripts-reference)
- [Architecture](#architecture)
- [Access Levels](#access-levels)

---

## Overview

This is a fully functional BBS that recreates the 90s terminal experience — ANSI art, colorful menus, message boards, one-liners, user profiles, and door games. Under the surface, an AI-powered horror game called **Last Logon** runs: the BBS sysadmin is secretly a serial killer, and each player's experience adapts based on their actions.

Key features:

- SSH server (classic terminal feel)
- Message boards with conferences and areas
- One-liner wall, bulletins, polls, who's online
- AI-driven killer persona (Claude) that adapts to each player
- 5-chapter story with puzzles, NPCs, clue discovery
- Pseudo-filesystem "hacking" terminal
- Bilingual support (English / German)
- Asynchronous gameplay (killer messages arrive over hours/days)

## Quick Start

```bash
# Install dependencies
npm install

# Generate SSH host keys (required, one-time)
npm run generate-keys

# Push database schema to SQLite
npm run db:push

# Start the BBS
npm run dev
```

Then connect:

```bash
ssh -p 2222 -o StrictHostKeyChecking=no anyuser@localhost
```

## Prerequisites

- **Node.js** >= 18
- **npm** >= 9
- **ssh-keygen** (comes with OpenSSH, needed for key generation)
- An **Anthropic API key** (for the AI game features)

## Installation

1. Clone the repository:

```bash
git clone https://github.com/kreuzhofer/last-logon.git
cd last-logon
```

2. Install dependencies:

```bash
npm install
```

3. Generate SSH host keys:

```bash
npm run generate-keys
```

This creates `config/ssh_host_key` (ed25519). The server will not start without it.

4. Create the `.env` file (see next section).

5. Push the database schema:

```bash
npm run db:push
```

6. (Optional) Seed demo data:

```bash
npm run seed
```

7. (Optional) Create a sysop account:

```bash
npm run create-sysop
```

## Environment Variables

Create a `.env` file in the project root:

```env
# Required — SQLite database path (relative to prisma/ directory)
DATABASE_URL="file:../data/bbs.sqlite3"

# Required for AI game features — Anthropic API key
ANTHROPIC_API_KEY="sk-ant-api03-your-key-here"
```

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | SQLite database connection string. The path is relative to the `prisma/` directory. Default: `file:../data/bbs.sqlite3` |
| `ANTHROPIC_API_KEY` | For game | Anthropic API key for Claude. Required for AI-driven game features (killer conversations, AI puzzle hints, async messages). The BBS itself works without it — only the game's AI features need it. Get one at [console.anthropic.com](https://console.anthropic.com/). |

### How the API key is used

The Vercel AI SDK (`ai` + `@ai-sdk/anthropic`) reads `ANTHROPIC_API_KEY` from the environment automatically. It is used for:

- Killer persona chat responses (structured tool_use with forced `respond_to_player`)
- AI-generated puzzle hints (when pre-defined hints are exhausted)
- Free-form answer evaluation (for AI-validated puzzles)
- Conversation summarization (cost-saving context compression)
- Async killer messages (background scheduler generates messages for inactive players)

The first scripted beats (prologue) do **not** require API calls — they are pre-written in the base script. API calls only begin once the player progresses past the intro.

## Configuration

All configuration lives in `config/default.hjson` (HJSON format — JSON with comments).

### General

```hjson
general: {
  bbsName: "The Neon Underground"
  sysopName: "The SysOp"
  sysopEmail: "sysop@example.com"
  tagline: "Where the 90s never ended"
  maxNodes: 10                    // Max concurrent SSH connections
  defaultTimeLimitMin: 60         // Session time limit in minutes
  newUserAccessLevel: 20          // Access level for new registrations
}
```

### Servers

```hjson
servers: {
  ssh: {
    enabled: true
    port: 2222                    // SSH listen port
    address: "0.0.0.0"           // Bind address
    hostKeyPath: "config/ssh_host_key"
  }
  websocket: {
    enabled: false                // Future feature
    port: 8080
    address: "0.0.0.0"
  }
}
```

### Terminal

```hjson
terminal: {
  defaultWidth: 80               // Classic 80-column terminal
  defaultHeight: 25              // Classic 25-row terminal
  defaultBaudRate: 19200         // Simulated modem speed for effects
  idleTimeoutSec: 300            // Disconnect after 5 min idle
}
```

### Authentication

```hjson
auth: {
  minPasswordLength: 6
  maxLoginAttempts: 3
  requireEmail: false
  allow2FA: true                 // TOTP two-factor auth
  allowSshKeys: true             // SSH public key authentication
}
```

### Paths

```hjson
paths: {
  art: "art"                     // ANSI art files
  data: "data"                   // Data directory
  files: "data/files"            // File area
  logs: "data/logs"              // Log files
}
```

### Logging

```hjson
logging: {
  level: "info"                  // trace, debug, info, warn, error, silent
  file: "data/logs/bbs.log"
  console: true
}
```

### Game (Last Logon)

```hjson
game: {
  enabled: true                          // Set false to disable the game entirely
  aiModel: "claude-sonnet-4-20250514"    // Anthropic model for AI features
  maxAiCallsPerMinute: 6                // Rate limit per player
  killerResponseDelayMin: 1800           // Min delay for async messages (30 min)
  killerResponseDelayMax: 86400          // Max delay (24 hours)
  inactivityReminderHours: 48           // Nag inactive players after 2 days
}
```

### Other Config Files

| File | Purpose |
|---|---|
| `config/menus.hjson` | Menu tree definitions (hotkeys, actions, layout) |
| `config/message-areas.hjson` | Message conferences and areas (seeded to DB on startup) |
| `config/base-script.hjson` | Narrative skeleton — chapters, beats, killer personality |
| `config/last-logon/puzzles.hjson` | Puzzle definitions (answers, hints, validators) |
| `config/last-logon/npcs.hjson` | NPC personalities and trigger conditions |
| `config/last-logon/filesystem.hjson` | Pseudo-filesystem tree for the hidden terminal |
| `config/last-logon/ai-prompts.hjson` | System prompt templates for Claude |

## Running the BBS

### Development (hot-reload)

```bash
npm run dev
```

### Production

```bash
npm run build
npm start
```

### Startup sequence

1. Load configuration from `config/default.hjson`
2. Initialize Prisma / SQLite database
3. Seed message areas from `config/message-areas.hjson`
4. Start SSH server on configured port
5. Start game scheduler (hourly background check for inactive players)

## Connecting

```bash
# Local
ssh -p 2222 -o StrictHostKeyChecking=no anyuser@localhost

# Remote (replace with your server IP)
ssh -p 2222 user@your-server-ip
```

Any username works for first connection — you'll be prompted to register a new account or log in to an existing one. Passwords are hashed with argon2.

## The Game: Last Logon

### Concept

The entire BBS **is** the game world. Every player has a persistent game state that determines what they see in the BBS. The game starts with a completely normal BBS experience — horror creeps in gradually over multiple logins.

### Chapters

| Chapter | Title | Description |
|---|---|---|
| Prologue | Welcome to the Board | Everything seems normal. Classic BBS. |
| Chapter 1 | Something's Off | Strange messages. A user mentions disappearances. |
| Chapter 2 | The Game Begins | The killer notices you. Direct contact. |
| Chapter 3 | Cat and Mouse | Adaptive difficulty. NPC alliances. |
| Chapter 4 | Closing In | Evidence mounting. Stakes rise. |
| Chapter 5a | Gotcha | Good ending — killer caught. |
| Chapter 5b | Last Logon | Cliffhanger — killer escapes. |

### Game Features

- **Progressive feature unlocking**: BBS features unlock as you progress (messages, bulletins, hidden files, system logs, admin traces)
- **Killer AI persona**: Powered by Claude — adapts mood, trust, and behavior to each player
- **5 puzzle types**: Cipher (ROT13), riddle (fuzzy matching), numeric, filesystem exploration, AI-evaluated evidence assembly
- **Hidden terminal**: Pseudo-shell (`ls`, `cd`, `cat`, `grep`) to "hack" into system files — clue-gated areas
- **NPCs**: Worried user, investigator, ghost user — each with personality and story arc
- **Async gameplay**: The killer responds over hours. Background scheduler sends messages to inactive players.
- **Bilingual**: Full English and German support (player choice at game start)

### How AI Costs Are Managed

- First scripted beats (prologue) require **zero API calls**
- Rolling conversation window (last 15 messages + AI-generated summary)
- Structured responses via forced tool_use (no wasted tokens)
- Rate limiting: configurable max calls per minute per player
- Deterministic puzzle validation for most puzzles (AI only for free-form answers)
- Configurable killer response delays (hours, not seconds)

## Testing

### Run all tests

```bash
npm test
```

### Watch mode

```bash
npm run test:watch
```

### Test coverage

81 tests across 4 test files:

| Test File | What It Tests |
|---|---|
| `tests/game/base-script-loader.test.ts` | Config loading, chapters, beats, clues, puzzles, NPCs, filesystem, AI prompts, template interpolation |
| `tests/game/puzzle-engine.test.ts` | All 6 validation strategies (exact, fuzzy, rot13, numeric, contains, AI fallback) |
| `tests/game/game-layer.test.ts` | Feature unlocking, clue/beat/puzzle state, beat trigger types, chapter progression |
| `tests/game/hidden-terminal.test.ts` | Path resolution, filesystem navigation, node visibility, clue gating |

### Interactive game tester

Test puzzles, explore the filesystem, and inspect game data without a full BBS session:

```bash
npx tsx scripts/test-game.ts
```

Options:
1. Browse base script and killer personality
2. Solve puzzles interactively (with hints and answer reveal)
3. Explore the pseudo-filesystem (all clues unlocked)
4. View NPC definitions
5. View and interpolate AI prompt templates
6. Chapter and beat overview

## Project Structure

```
last-logon/
├── config/
│   ├── default.hjson              # Main BBS configuration
│   ├── menus.hjson                # Menu definitions
│   ├── message-areas.hjson        # Message board areas
│   ├── base-script.hjson          # Game narrative skeleton
│   └── last-logon/
│       ├── puzzles.hjson          # Puzzle definitions
│       ├── npcs.hjson             # NPC personalities
│       ├── filesystem.hjson       # Pseudo-filesystem tree
│       └── ai-prompts.hjson       # AI system prompt templates
├── prisma/
│   └── schema.prisma              # Database schema (23 models)
├── src/
│   ├── index.ts                   # Entry point
│   ├── core/
│   │   ├── bbs.ts                 # Main BBS loop & modules
│   │   ├── config.ts              # Config loading
│   │   ├── database.ts            # Prisma client singleton
│   │   ├── events.ts              # Typed event bus
│   │   ├── logger.ts              # Pino logger
│   │   └── errors.ts              # Error types
│   ├── server/
│   │   ├── ssh-server.ts          # SSH server (ssh2)
│   │   └── connection.ts          # Transport abstraction
│   ├── terminal/
│   │   ├── terminal.ts            # Terminal I/O (readKey, readLine, cursor)
│   │   ├── screen-frame.ts        # 80x25 frame with borders & hotkeys
│   │   ├── ansi.ts                # ANSI color/cursor codes
│   │   └── menu-art.ts            # Generated menu art
│   ├── auth/
│   │   └── session.ts             # Session & auth management
│   ├── messages/
│   │   └── message-service.ts     # Message board CRUD
│   ├── utils/
│   │   └── pipe-codes.ts          # BBS pipe code parser (|00-|23)
│   └── game/
│       ├── index.ts               # Game entry point & menu
│       ├── game-layer.ts          # Central game logic & state
│       ├── game-types.ts          # TypeScript interfaces
│       ├── game-init.ts           # Language select & prologue
│       ├── ai-engine.ts           # Vercel AI SDK + Anthropic
│       ├── base-script-loader.ts  # HJSON config loader
│       ├── narrative.ts           # Typewriter effects & chat UI
│       ├── hidden-terminal.ts     # Pseudo-shell (ls, cd, cat, grep)
│       ├── message-bridge.ts      # Game messages → BBS messages
│       ├── scheduler.ts           # Background job for async messages
│       └── puzzles/
│           └── puzzle-engine.ts   # Puzzle framework & validation
├── tests/
│   ├── setup.ts                   # Test setup (mocked config)
│   └── game/
│       ├── base-script-loader.test.ts
│       ├── puzzle-engine.test.ts
│       ├── game-layer.test.ts
│       └── hidden-terminal.test.ts
├── scripts/
│   ├── generate-ssh-keys.ts       # SSH key generation
│   └── test-game.ts               # Interactive game tester
├── data/                          # SQLite database & logs (gitignored)
├── art/                           # ANSI art files
├── vitest.config.ts
├── package.json
├── tsconfig.json
└── .env                           # Environment variables (not in repo)
```

## Database

SQLite via Prisma ORM. The database is stored at `data/bbs.sqlite3`.

### Core BBS models

`User`, `Node`, `Oneliner`, `Bulletin`, `LastCaller`, `Poll`, `PollOption`, `PollVote`, `DoorGame`, `MessageConference`, `MessageArea`, `Message`, `MessageRead`, `GameState`, `GameScore`, `SystemLog`

### Last Logon game models

| Model | Purpose |
|---|---|
| `PlayerGame` | Per-player game state (chapter, phase, killer mood/trust, clues, puzzles, features) |
| `GameEvent` | Timeline of story events for AI memory (type, importance, chapter) |
| `GameNPC` | NPCs instantiated per player (handle, role, personality, relationship) |
| `GameConversation` | AI conversation log (messages between player and killer) |
| `GameNotification` | Pending notifications (killer messages, story events) |
| `GamePuzzleState` | Puzzle progress (attempts, hints used, solved status) |

### Database commands

```bash
npm run db:push       # Apply schema changes to SQLite
npm run db:generate   # Regenerate Prisma client after schema edits
npm run db:studio     # Open Prisma Studio GUI (browser-based)
```

## Scripts Reference

| Command | Description |
|---|---|
| `npm run dev` | Start BBS with hot-reload (tsx --watch) |
| `npm run build` | Production build (tsup, ESM output) |
| `npm start` | Run production build |
| `npm test` | Run tests (vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run lint` | ESLint on src/ |
| `npm run format` | Prettier on src/ and config/ |
| `npm run generate-keys` | Generate SSH host keys (one-time) |
| `npm run create-sysop` | Create sysop account interactively |
| `npm run seed` | Seed demo data (users, messages) |
| `npm run db:push` | Push Prisma schema to SQLite |
| `npm run db:generate` | Regenerate Prisma client |
| `npm run db:studio` | Open Prisma Studio in browser |
| `npx tsx scripts/test-game.ts` | Interactive game/puzzle tester |

## Architecture

### Connection Flow

```
SSH Client → ssh-server.ts → SSHConnection → Terminal → Session → ScreenFrame → bbs.ts
```

### Game Flow

```
Player Login → GameLayer.onPlayerLogin() → Check Notifications → Main Menu
                                                                      │
                    ┌──────────────┬──────────────┬──────────────┐    │
                    ▼              ▼              ▼              ▼    ▼
              Terminal Chat   Messages    Hidden Terminal   Journal  Puzzles
              (AI Killer)    (Killer/NPC)  (Pseudo-Shell)  (Clues)  (Cipher/Riddle)
                    │              │              │              │    │
                    └──────────────┴──────────────┴──────────────┘    │
                                        │                             │
                              GameLayer (state updates)               │
                                        │                             │
                              AI Engine (Claude API)                  │
                                        │                             │
                              Base Script (HJSON) ────────────────────┘
```

### Key Design Decisions

- **ESM modules** with `.js` import extensions (TypeScript source, ESM output)
- **ScreenFrame pattern**: Every screen renders within an 80x25 bordered frame
- **Pipe codes**: Classic BBS `|00`-`|15` foreground, `|16`-`|23` background colors
- **Singleton config**: `getConfig()` returns cached parsed HJSON
- **Prisma singleton**: `getDb()` returns shared Prisma client
- **Structured AI responses**: Forced tool_use (`respond_to_player`) ensures predictable response format
- **Pre-scripted intro**: Prologue beats are hardcoded — no API calls until the player progresses

## Access Levels

| Level | Role | Capabilities |
|---|---|---|
| 0 | Locked | Cannot log in |
| 20 | New User | Basic BBS features |
| 100 | Normal | Full BBS access |
| 200 | Co-SysOp | Moderation tools |
| 255 | SysOp | Full admin access |

## License

MIT
