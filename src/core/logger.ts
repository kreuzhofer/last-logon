import pino from 'pino';
import { getConfig } from './config.js';

let logger: pino.Logger | undefined;

export function getLogger(): pino.Logger {
  if (!logger) {
    const config = getConfig();
    const targets: pino.TransportTargetOptions[] = [];

    if (config.logging.console) {
      targets.push({
        target: 'pino-pretty',
        options: { colorize: true },
        level: config.logging.level,
      });
    }

    if (config.logging.file) {
      targets.push({
        target: 'pino/file',
        options: { destination: config.logging.file, mkdir: true },
        level: config.logging.level,
      });
    }

    if (targets.length > 0) {
      logger = pino({
        level: config.logging.level,
        transport: { targets },
      });
    } else {
      logger = pino({ level: config.logging.level });
    }
  }
  return logger;
}

export function createChildLogger(name: string): pino.Logger {
  return getLogger().child({ module: name });
}
