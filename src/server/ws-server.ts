// WebSocket server — browser-based terminal access to the BBS
// Implements IConnection so the BBS doesn't know the difference from SSH

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { getConfig, getProjectRoot } from '../core/config.js';
import { createChildLogger } from '../core/logger.js';
import { type IConnection, allocateNodeNumber, releaseNodeNumber } from './connection.js';
import { eventBus } from '../core/events.js';

const log = createChildLogger('ws-server');

// ─── WebSocket Connection ───────────────────────────────────────────────────

export class WebSocketConnection implements IConnection {
  readonly id: string;
  readonly connectedAt: Date;
  private dataCallbacks: ((data: Buffer) => void)[] = [];
  private closeCallbacks: (() => void)[] = [];
  private resizeCallbacks: ((width: number, height: number) => void)[] = [];
  private closed = false;

  screenWidth: number;
  screenHeight: number;
  terminalType: string;
  detectedTimezone?: string;

  constructor(
    readonly nodeNumber: number,
    readonly remoteAddress: string,
    private ws: WebSocket,
  ) {
    this.id = randomUUID();
    this.connectedAt = new Date();
    this.screenWidth = 80;
    this.screenHeight = 25;
    this.terminalType = 'xterm-256color';

    this.ws.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8'));
        if (msg.type === 'input' && typeof msg.data === 'string') {
          const buf = Buffer.from(msg.data, 'utf-8');
          for (const cb of this.dataCallbacks) cb(buf);
        } else if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
          this.screenWidth = msg.cols;
          this.screenHeight = msg.rows;
          if (typeof msg.timezone === 'string' && msg.timezone) {
            this.detectedTimezone = msg.timezone;
          }
          for (const cb of this.resizeCallbacks) cb(msg.cols, msg.rows);
        }
      } catch {
        // Ignore malformed messages
      }
    });

    this.ws.on('close', () => {
      if (!this.closed) {
        this.closed = true;
        releaseNodeNumber(this.nodeNumber);
        for (const cb of this.closeCallbacks) cb();
      }
    });

    this.ws.on('error', () => {
      this.close();
    });
  }

  write(data: string | Buffer): void {
    if (!this.closed && this.ws.readyState === WebSocket.OPEN) {
      try {
        const str = typeof data === 'string' ? data : data.toString('utf-8');
        this.ws.send(JSON.stringify({ type: 'output', data: str }));
      } catch {
        // WebSocket may have closed
      }
    }
  }

  onData(callback: (data: Buffer) => void): void {
    this.dataCallbacks.push(callback);
  }

  onClose(callback: () => void): void {
    this.closeCallbacks.push(callback);
    if (this.closed) callback();
  }

  onResize(callback: (width: number, height: number) => void): void {
    this.resizeCallbacks.push(callback);
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      releaseNodeNumber(this.nodeNumber);
      try {
        this.ws.close();
      } catch {
        // Already closed
      }
      for (const cb of this.closeCallbacks) cb();
    }
  }
}

// ─── Server ─────────────────────────────────────────────────────────────────

export type ConnectionHandler = (conn: WebSocketConnection) => void;

export function startWebSocketServer(onConnection: ConnectionHandler): Promise<void> {
  const config = getConfig();
  const { port, address } = config.servers.websocket;

  // Load the static HTML client
  const publicDir = resolve(getProjectRoot(), 'public');
  const indexPath = resolve(publicDir, 'index.html');
  const indexHtml = existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : '<html><body>BBS Web Client not found</body></html>';

  // Create HTTP server to serve static client + upgrade to WebSocket
  const httpServer = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(indexHtml);
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws, req) => {
    const clientAddr = req.socket.remoteAddress ?? 'unknown';
    log.info({ remoteAddress: clientAddr }, 'WebSocket client connected');

    const nodeNumber = allocateNodeNumber(config.general.maxNodes);
    if (nodeNumber === null) {
      ws.send(JSON.stringify({ type: 'output', data: '\r\n*** All nodes are busy. Please try again later. ***\r\n' }));
      ws.close();
      return;
    }

    const conn = new WebSocketConnection(nodeNumber, clientAddr, ws);

    log.info(
      { nodeNumber, remoteAddress: clientAddr, terminal: 'xterm-256color', size: '80x25' },
      'WebSocket shell session started',
    );

    eventBus.emit('node:activity', { nodeNumber, activity: 'Connected' });

    onConnection(conn);
  });

  return new Promise((resolve, reject) => {
    httpServer.listen(port, address, () => {
      log.info({ port, address }, 'WebSocket server listening');
      resolve();
    });

    httpServer.on('error', (err) => {
      log.error({ error: err }, 'WebSocket server error');
      reject(err);
    });
  });
}
