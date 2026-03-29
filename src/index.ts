import { loadConfig, getConfig } from './core/config.js';
import { createChildLogger } from './core/logger.js';
import { initDatabase, closeDatabase } from './core/database.js';
import { startSSHServer } from './server/ssh-server.js';
import { handleSession } from './core/bbs.js';
import { seedMessageAreas } from './messages/message-service.js';
import { seedBBSContent } from './game/content-seeder.js';
import { startGameScheduler, stopGameScheduler } from './game/scheduler.js';

// Load config first
loadConfig();
const config = getConfig();
const log = createChildLogger('main');

log.info(`Starting ${config.general.bbsName}...`);

// Initialize Prisma
await initDatabase();

// Seed message areas from config
await seedMessageAreas();

// Seed BBS content (fake users, messages, one-liners, etc.)
await seedBBSContent();

// Validate AI configuration if game is enabled
if (config.game?.enabled !== false) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'sk-ant-api03-your-key-here') {
    log.fatal('Game is enabled but ANTHROPIC_API_KEY is not configured. Set it in .env or disable the game (game.enabled: false in config/default.hjson).');
    process.exit(1);
  }
  log.info({ model: config.game?.aiModel ?? 'claude-sonnet-4-20250514' }, 'AI configuration validated');
}

// Start SSH server
const server = await startSSHServer((conn) => {
  handleSession(conn).catch((err) => {
    log.error({ error: err, node: conn.nodeNumber }, 'Unhandled session error');
  });
});

// Start game scheduler for async killer messages
if (config.game?.enabled !== false) {
  startGameScheduler();
  log.info('Last Logon game scheduler started');
}

log.info(`${config.general.bbsName} is online!`);
log.info(`SSH: ssh localhost -p ${config.servers.ssh.port}`);

// Catch all uncaught errors through pino
process.on('uncaughtException', (err) => {
  log.fatal({ error: err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.fatal({ error: reason }, 'Unhandled rejection');
  process.exit(1);
});

// Graceful shutdown
async function shutdown() {
  log.info('Shutting down...');
  stopGameScheduler();
  server.close();
  await closeDatabase();
  process.exit(0);
}

process.on('SIGINT', () => { shutdown(); });
process.on('SIGTERM', () => { shutdown(); });
