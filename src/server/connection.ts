// Unified Connection interface
// Abstracts transport differences (SSH, WebSocket in the future)

import { randomUUID } from 'node:crypto';

export interface IConnection {
  readonly id: string;
  readonly nodeNumber: number;
  readonly remoteAddress: string;
  readonly connectedAt: Date;

  screenWidth: number;
  screenHeight: number;
  terminalType: string;

  write(data: string | Buffer): void;
  onData(callback: (data: Buffer) => void): void;
  onClose(callback: () => void): void;
  onResize(callback: (width: number, height: number) => void): void;
  close(): void;
}

// Tracks assigned node numbers
const activeNodes = new Set<number>();

export function allocateNodeNumber(maxNodes: number): number | null {
  for (let i = 1; i <= maxNodes; i++) {
    if (!activeNodes.has(i)) {
      activeNodes.add(i);
      return i;
    }
  }
  return null;
}

export function releaseNodeNumber(nodeNumber: number): void {
  activeNodes.delete(nodeNumber);
}

export function getActiveNodeCount(): number {
  return activeNodes.size;
}

export class SSHConnection implements IConnection {
  readonly id: string;
  readonly connectedAt: Date;
  private dataCallbacks: ((data: Buffer) => void)[] = [];
  private closeCallbacks: (() => void)[] = [];
  private resizeCallbacks: ((width: number, height: number) => void)[] = [];
  private closed = false;

  screenWidth: number;
  screenHeight: number;
  terminalType: string;

  constructor(
    readonly nodeNumber: number,
    readonly remoteAddress: string,
    private stream: NodeJS.ReadWriteStream,
    options?: { width?: number; height?: number; term?: string },
  ) {
    this.id = randomUUID();
    this.connectedAt = new Date();
    this.screenWidth = options?.width ?? 80;
    this.screenHeight = options?.height ?? 25;
    this.terminalType = options?.term ?? 'xterm';

    this.stream.on('data', (data: Buffer) => {
      for (const cb of this.dataCallbacks) cb(data);
    });

    this.stream.on('close', () => {
      if (!this.closed) {
        this.closed = true;
        releaseNodeNumber(this.nodeNumber);
        for (const cb of this.closeCallbacks) cb();
      }
    });

    this.stream.on('error', () => {
      this.close();
    });
  }

  write(data: string | Buffer): void {
    if (!this.closed) {
      try {
        (this.stream as NodeJS.WritableStream).write(data);
      } catch {
        // Stream may have closed
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

  handleResize(width: number, height: number): void {
    this.screenWidth = width;
    this.screenHeight = height;
    for (const cb of this.resizeCallbacks) cb(width, height);
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      releaseNodeNumber(this.nodeNumber);
      try {
        (this.stream as NodeJS.WritableStream).end();
      } catch {
        // Already closed
      }
      for (const cb of this.closeCallbacks) cb();
    }
  }
}
