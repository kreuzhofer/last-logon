import type { User } from '@prisma/client';
import type { IConnection } from '../server/connection.js';
import { Terminal } from '../terminal/terminal.js';

export class Session {
  user: User | null = null;
  authenticated = false;
  loginAttempts = 0;
  startTime: Date;

  constructor(
    public readonly connection: IConnection,
    public readonly terminal: Terminal,
  ) {
    this.startTime = new Date();
  }

  get nodeNumber(): number {
    return this.connection.nodeNumber;
  }

  get remoteAddress(): string {
    return this.connection.remoteAddress;
  }

  get handle(): string {
    return this.user?.handle ?? 'Unknown';
  }

  get accessLevel(): number {
    return this.user?.accessLevel ?? 0;
  }

  get isSysop(): boolean {
    return this.accessLevel >= 255;
  }

  get isCoSysop(): boolean {
    return this.accessLevel >= 200;
  }

  login(user: User): void {
    this.user = user;
    this.authenticated = true;
    this.loginAttempts = 0;
  }

  logout(): void {
    this.user = null;
    this.authenticated = false;
  }

  get timeOnlineMinutes(): number {
    return Math.floor((Date.now() - this.startTime.getTime()) / 60000);
  }

  get timeRemainingMinutes(): number {
    if (!this.user) return 0;
    return Math.max(0, this.user.timeLimitMin - this.user.timeUsedToday - this.timeOnlineMinutes);
  }
}
