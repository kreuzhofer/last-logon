// Test setup — initialize environment for tests
// Sets up a test database and mock config

import { vi } from 'vitest';

// Set test database path (absolute to avoid Prisma resolution issues)
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const testDbPath = path.resolve(__dirname, '..', 'data', 'test-bbs.sqlite3');
process.env.DATABASE_URL = `file:${testDbPath}`;

// Mock config with test-friendly values
vi.mock('../src/core/config.js', () => ({
  loadConfig: vi.fn(),
  getConfig: vi.fn(() => ({
    general: {
      bbsName: 'Test BBS',
      sysopName: 'TestSysop',
      sysopEmail: 'test@example.com',
      tagline: 'Test tagline',
      maxNodes: 5,
      defaultTimeLimitMin: 60,
      newUserAccessLevel: 20,
    },
    servers: {
      ssh: { enabled: true, port: 2222, address: '0.0.0.0', hostKeyPath: 'config/ssh_host_key' },
      websocket: { enabled: false, port: 8080, address: '0.0.0.0' },
    },
    terminal: { defaultWidth: 80, defaultHeight: 25, defaultBaudRate: 19200, idleTimeoutSec: 300 },
    auth: { minPasswordLength: 6, maxLoginAttempts: 3, requireEmail: false },
    paths: { art: 'art', data: 'data', files: 'data/files', logs: 'data/logs' },
    logging: { level: 'silent', file: '', console: false },
    game: { enabled: true, aiModel: 'test-model', maxAiCallsPerMinute: 10, inactivityReminderHours: 48 },
  })),
  getProjectRoot: vi.fn(() => process.cwd()),
}));
