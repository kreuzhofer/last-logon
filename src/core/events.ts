import { EventEmitter } from 'node:events';

export interface BBSEvents {
  'user:login': { nodeNumber: number; userId: number; handle: string };
  'user:logoff': { nodeNumber: number; userId: number };
  'message:new': { areaTag: string; messageId: number; from: string; subject: string };
  'chat:message': { channel: string; from: string; text: string };
  'node:activity': { nodeNumber: number; activity: string };
  'sysop:alert': { type: string; message: string };
  'bridge:incoming': { bridge: string; message: unknown };
}

class BBSEventBus extends EventEmitter {
  emit<K extends keyof BBSEvents>(event: K, data: BBSEvents[K]): boolean {
    return super.emit(event, data);
  }

  on<K extends keyof BBSEvents>(event: K, listener: (data: BBSEvents[K]) => void): this {
    return super.on(event, listener);
  }

  once<K extends keyof BBSEvents>(event: K, listener: (data: BBSEvents[K]) => void): this {
    return super.once(event, listener);
  }
}

export const eventBus = new BBSEventBus();
