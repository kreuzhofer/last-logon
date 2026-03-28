# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A classic BBS (Bulletin Board System) that runs over SSH, recreating the 90s terminal experience with ANSI art, colorful menus, message boards, and door games — but backed by modern tech (Prisma, TypeScript, planned Telegram/email bridges).

## Commands

```bash
npm run dev              # Start BBS with hot-reload (tsx --watch)
npm run generate-keys    # Generate SSH host keys (required before first run)
npm run db:push          # Push Prisma schema changes to SQLite
npm run db:generate      # Regenerate Prisma client after schema changes
npm run db:studio        # Open Prisma Studio GUI for data inspection
npm test                 # Run tests (vitest run)
npm run test:watch       # Run tests in watch mode (vitest)
npm run lint             # ESLint on src/
npm run format           # Prettier on src/**/*.ts and config/**/*.hjson
npm run build            # Production build (tsup)
npm run create-sysop     # Create sysop account via CLI
npm run seed             # Seed demo data
```

**First-time setup:** `npm run generate-keys && npm run db:push && npm run dev`

**Connect:** `ssh -p 2222 -o StrictHostKeyChecking=no anyuser@localhost`

## Architecture

### Connection Flow

```
SSH Client → ssh-server.ts → SSHConnection → Terminal → Session → ScreenFrame → bbs.ts (handleSession)
```

Each SSH connection gets a `Session` wrapping a `Terminal` wrapping a `Connection`. The session flows: Welcome → Login/Register → Main Menu → Modules → Goodbye.

### ESM Module System

The project uses ESM (`"type": "module"` in package.json). All local imports must use `.js` extensions (e.g., `import { foo } from './bar.js'`) even though source files are `.ts`. TypeScript is configured with `"module": "ESNext"` and `"moduleResolution": "bundler"`.

### ScreenFrame (critical pattern)

**Every screen** must use `ScreenFrame` for consistent UI. The frame draws a double-line border around the entire 80x25 terminal with:
- **Top border (row 1):** breadcrumb showing navigation path (e.g., `╔═ BBS Name > Messages > Read ═══╗`)
- **Content area (rows 2-24, cols 3-78):** 76 chars wide, 23 rows tall
- **Bottom border (row 25):** context-sensitive hotkey bar (e.g., `╚═ [N]ext ═ [P]rev ═ [R]eply ═ [Q]uit ═══╝`)

When adding a new screen, always:
1. Call `frame.refresh([...breadcrumb], hotkeyDefs)` to redraw the frame
2. Use `frame.writeContentLine()` / `frame.skipLine()` for content (not `terminal.writeLine()`)
3. Use `terminal.moveTo(frame.currentRow, frame.contentLeft)` before prompts/input

### Data Layer

- **Prisma schema-first** (`prisma/schema.prisma`) — single source of truth for all models
- **SQLite** database at `data/bbs.sqlite3`
- Access via `getDb()` from `src/core/database.ts` (Prisma client singleton)
- Auth uses argon2 for password hashing

### Configuration

- `config/default.hjson` — BBS settings (name, ports, limits, auth rules). Parsed with the `hjson` package.
- `config/menus.hjson` — menu tree definitions (hotkeys, actions, targets)
- `config/message-areas.hjson` — message conferences and areas (seeded to DB on startup via `seedMessageAreas()`)

### Key Abstractions

- **`IConnection`** (`src/server/connection.ts`): transport-agnostic interface. `SSHConnection` implements it; designed for future WebSocket transport too. Node number allocation/release is managed here.
- **`Terminal`** (`src/terminal/terminal.ts`): wraps `IConnection`, provides `readKey()`, `readLine()`, `readHotkey()`, cursor/color control
- **`ScreenFrame`** (`src/terminal/screen-frame.ts`): persistent border chrome, breadcrumb, hotkey bar
- **`Session`** (`src/auth/session.ts`): user state, auth status, wraps Terminal + Connection
- **Color helpers** in `bbs.ts`: `c(Color.LightCyan, "text")` for inline ANSI coloring
- **Pipe codes** (`src/utils/pipe-codes.ts`): classic BBS `|00`-`|15` foreground, `|16`-`|23` background color codes
- **Event bus** (`src/core/events.ts`): typed `BBSEventBus` emitting events like `user:login`, `message:new`, `node:activity`
- **Logging**: pino-based, use `createChildLogger('module-name')` from `src/core/logger.ts`

### Menu Engine

`src/menus/menu-engine.ts` loads menu definitions from `config/menus.hjson`. Each menu has:
- `generator`: name of a code-generated art function (in `src/terminal/menu-art.ts`)
- `hotkeys`: map of key → `MenuAction` (`{ action: 'menu'|'module'|'back'|'disconnect', target?: string }`)
- `prompt`: pipe-code formatted prompt string

Modules are registered via `registerModule()` and looked up by name. Currently, bbs.ts handles module dispatch directly in `mainMenuLoop()` switch statements rather than going through the registry.

### Module Pattern

Each BBS feature (messages, who's online, one-liners, etc.) is an async function in `src/core/bbs.ts` with signature:
```typescript
async function moduleName(session: Session, frame: ScreenFrame): Promise<void>
```

### Access Level System

User access levels: 0=locked, 20=new user, 100=normal, 200=co-sysop, 255=sysop.

## npm Networking Issue

Node.js HTTPS is blocked by the macOS Application Firewall on this machine. `npm install` fails with ECONNRESET. **Workaround:** download tarballs via curl, install from local files:
```bash
curl -sL "https://registry.npmjs.org/PACKAGE/-/PACKAGE-VERSION.tgz" -o /tmp/pkg.tgz
npm install /tmp/pkg.tgz --install-strategy=shallow
```
