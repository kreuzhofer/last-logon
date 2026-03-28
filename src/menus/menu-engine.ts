// Config-driven menu engine
// Reads menu definitions from menus.hjson and drives the BBS navigation

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import hjson from 'hjson';
import { getConfig, getProjectRoot } from '../core/config.js';
import { createChildLogger } from '../core/logger.js';
import { MenuError } from '../core/errors.js';
import type { Session } from '../auth/session.js';
import { Terminal } from '../terminal/terminal.js';

const log = createChildLogger('menu-engine');

export interface MenuAction {
  action: 'menu' | 'module' | 'back' | 'disconnect';
  target?: string;
  access?: { minLevel?: number };
}

export interface MenuDef {
  art?: string;
  generator?: string; // Name of code-generated art function
  hotkeys: Record<string, MenuAction>;
  prompt?: string;
}

export interface MenuConfig {
  menus: Record<string, MenuDef>;
}

let menuConfig: MenuConfig | undefined;

export function loadMenuConfig(): MenuConfig {
  const configPath = resolve(getProjectRoot(), 'config/menus.hjson');
  if (!existsSync(configPath)) {
    throw new MenuError(`Menu config not found at ${configPath}`);
  }
  const raw = readFileSync(configPath, 'utf-8');
  menuConfig = hjson.parse(raw) as MenuConfig;
  return menuConfig;
}

export function getMenuConfig(): MenuConfig {
  if (!menuConfig) return loadMenuConfig();
  return menuConfig;
}

export function getMenuDef(menuName: string): MenuDef {
  const config = getMenuConfig();
  const menu = config.menus[menuName];
  if (!menu) {
    throw new MenuError(`Menu "${menuName}" not found in config`);
  }
  return menu;
}

// Menu stack for navigation
export class MenuStack {
  private stack: string[] = [];

  push(menuName: string): void {
    this.stack.push(menuName);
  }

  pop(): string | undefined {
    return this.stack.pop();
  }

  peek(): string | undefined {
    return this.stack[this.stack.length - 1];
  }

  clear(): void {
    this.stack = [];
  }

  get depth(): number {
    return this.stack.length;
  }
}

export type ModuleRunner = (session: Session) => Promise<void>;

// Registry of menu modules
const moduleRegistry = new Map<string, ModuleRunner>();

export function registerModule(name: string, runner: ModuleRunner): void {
  moduleRegistry.set(name, runner);
}

export function getModule(name: string): ModuleRunner | undefined {
  return moduleRegistry.get(name);
}
