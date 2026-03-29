import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import hjson from 'hjson';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');

export interface BBSConfig {
  general: {
    bbsName: string;
    sysopName: string;
    sysopEmail: string;
    tagline: string;
    maxNodes: number;
    defaultTimeLimitMin: number;
    newUserAccessLevel: number;
  };
  servers: {
    ssh: {
      enabled: boolean;
      port: number;
      address: string;
      hostKeyPath: string;
    };
    websocket: {
      enabled: boolean;
      port: number;
      address: string;
    };
  };
  terminal: {
    defaultWidth: number;
    defaultHeight: number;
    defaultBaudRate: number;
    idleTimeoutSec: number;
  };
  auth: {
    minPasswordLength: number;
    maxLoginAttempts: number;
    requireEmail: boolean;
    allow2FA: boolean;
    allowSshKeys: boolean;
  };
  paths: {
    art: string;
    data: string;
    files: string;
    logs: string;
  };
  logging: {
    level: string;
    file: string;
    console: boolean;
  };
  game?: {
    enabled: boolean;
    aiModel: string;
    maxAiCallsPerMinute: number;
    killerResponseDelayMin: number;
    killerResponseDelayMax: number;
    inactivityReminderHours: number;
  };
}

const DEFAULTS: BBSConfig = {
  general: {
    bbsName: 'The Neon Underground',
    sysopName: 'The SysOp',
    sysopEmail: 'sysop@example.com',
    tagline: 'Where the 90s never ended',
    maxNodes: 10,
    defaultTimeLimitMin: 60,
    newUserAccessLevel: 20,
  },
  servers: {
    ssh: {
      enabled: true,
      port: 2222,
      address: '0.0.0.0',
      hostKeyPath: 'config/ssh_host_key',
    },
    websocket: {
      enabled: false,
      port: 8080,
      address: '0.0.0.0',
    },
  },
  terminal: {
    defaultWidth: 80,
    defaultHeight: 25,
    defaultBaudRate: 19200,
    idleTimeoutSec: 300,
  },
  auth: {
    minPasswordLength: 6,
    maxLoginAttempts: 3,
    requireEmail: false,
    allow2FA: true,
    allowSshKeys: true,
  },
  paths: {
    art: 'art',
    data: 'data',
    files: 'data/files',
    logs: 'data/logs',
  },
  logging: {
    level: 'info',
    file: 'data/logs/bbs.log',
    console: true,
  },
};

let config: BBSConfig | undefined;

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = target[key];
    if (sourceVal && typeof sourceVal === 'object' && !Array.isArray(sourceVal) &&
        targetVal && typeof targetVal === 'object' && !Array.isArray(targetVal)) {
      result[key] = deepMerge(targetVal as Record<string, unknown>, sourceVal as Record<string, unknown>);
    } else {
      result[key] = sourceVal;
    }
  }
  return result;
}

export function loadConfig(configPath?: string): BBSConfig {
  const filePath = configPath ?? resolve(PROJECT_ROOT, 'config/default.hjson');
  let userConfig: Record<string, unknown> = {};

  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, 'utf-8');
    userConfig = hjson.parse(raw) as Record<string, unknown>;
  }

  config = deepMerge(DEFAULTS as unknown as Record<string, unknown>, userConfig) as unknown as BBSConfig;

  // Resolve relative paths against project root
  config.paths.art = resolve(PROJECT_ROOT, config.paths.art);
  config.paths.data = resolve(PROJECT_ROOT, config.paths.data);
  config.paths.files = resolve(PROJECT_ROOT, config.paths.files);
  config.paths.logs = resolve(PROJECT_ROOT, config.paths.logs);
  config.servers.ssh.hostKeyPath = resolve(PROJECT_ROOT, config.servers.ssh.hostKeyPath);
  if (config.logging.file) {
    config.logging.file = resolve(PROJECT_ROOT, config.logging.file);
  }

  return config;
}

export function getConfig(): BBSConfig {
  if (!config) {
    return loadConfig();
  }
  return config;
}

export function getProjectRoot(): string {
  return PROJECT_ROOT;
}
