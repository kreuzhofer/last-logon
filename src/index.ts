import { loadConfig, getConfig } from './core/config.js';
import { createChildLogger } from './core/logger.js';
import { initDatabase, closeDatabase } from './core/database.js';
import { startSSHServer } from './server/ssh-server.js';
import { handleSession } from './core/bbs.js';
import { seedMessageAreas } from './messages/message-service.js';

// Load config first
loadConfig();
const config = getConfig();
const log = createChildLogger('main');

log.info(`Starting ${config.general.bbsName}...`);

// Initialize Prisma
await initDatabase();

// Seed message areas from config
await seedMessageAreas();

// Start SSH server
const server = await startSSHServer((conn) => {
  handleSession(conn).catch((err) => {
    log.error({ error: err, node: conn.nodeNumber }, 'Unhandled session error');
  });
});

log.info(`${config.general.bbsName} is online!`);
log.info(`SSH: ssh localhost -p ${config.servers.ssh.port}`);

// Graceful shutdown
async function shutdown() {
  log.info('Shutting down...');
  server.close();
  await closeDatabase();
  process.exit(0);
}

process.on('SIGINT', () => { shutdown(); });
process.on('SIGTERM', () => { shutdown(); });
