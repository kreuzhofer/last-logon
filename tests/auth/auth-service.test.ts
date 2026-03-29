// Tests for auth-service.ts — password hashing, handle validation, user CRUD, login/logout

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  hashPassword,
  verifyPassword,
  registerUser,
  loginUser,
  logoutUser,
  getUserByHandle,
  getUserById,
} from '../../src/auth/auth-service.js';
import { AuthError } from '../../src/core/errors.js';
import { initDatabase, closeDatabase, getDb } from '../../src/core/database.js';

let db: PrismaClient;

beforeAll(async () => {
  db = await initDatabase();
});

afterAll(async () => {
  await closeDatabase();
});

afterEach(async () => {
  // Clean up all test data between tests (order matters for foreign keys)
  await db.lastCaller.deleteMany();
  await db.node.deleteMany();
  await db.user.deleteMany();
});

// ─── Password Hashing ───────────────────────────────────────────────────────

describe('hashPassword + verifyPassword', () => {
  it('should hash a password and verify it with the correct password', async () => {
    const hash = await hashPassword('secret123');
    expect(hash).toBeDefined();
    expect(hash).not.toBe('secret123');

    const result = await verifyPassword(hash, 'secret123');
    expect(result).toBe(true);
  });

  it('should reject a wrong password', async () => {
    const hash = await hashPassword('secret123');
    const result = await verifyPassword(hash, 'wrongpassword');
    expect(result).toBe(false);
  });

  it('should produce different hashes for the same password (salt)', async () => {
    const hash1 = await hashPassword('samepass');
    const hash2 = await hashPassword('samepass');
    expect(hash1).not.toBe(hash2);
  });
});

describe('verifyPassword with corrupt hash', () => {
  it('should return false (not throw) for a corrupt hash', async () => {
    const result = await verifyPassword('not-a-valid-argon2-hash', 'password');
    expect(result).toBe(false);
  });

  it('should return false for an empty hash', async () => {
    const result = await verifyPassword('', 'password');
    expect(result).toBe(false);
  });
});

// ─── Handle Validation ──────────────────────────────────────────────────────

describe('validateHandle (via registerUser)', () => {
  it('should accept valid handles', async () => {
    const user = await registerUser('Valid_Handle-1', 'password123');
    expect(user.handle).toBe('Valid_Handle-1');
  });

  it('should accept a 2-character handle (minimum)', async () => {
    const user = await registerUser('ab', 'password123');
    expect(user.handle).toBe('ab');
  });

  it('should accept a 30-character handle (maximum)', async () => {
    const handle = 'a'.repeat(30);
    const user = await registerUser(handle, 'password123');
    expect(user.handle).toBe(handle);
  });

  it('should reject an empty handle', async () => {
    await expect(registerUser('', 'password123')).rejects.toThrow(AuthError);
    await expect(registerUser('', 'password123')).rejects.toThrow(
      'Handle must be 2-30 characters',
    );
  });

  it('should reject a single-character handle (too short)', async () => {
    await expect(registerUser('a', 'password123')).rejects.toThrow(AuthError);
  });

  it('should reject a handle longer than 30 characters', async () => {
    const handle = 'a'.repeat(31);
    await expect(registerUser(handle, 'password123')).rejects.toThrow(AuthError);
  });

  it('should reject handles with special characters', async () => {
    await expect(registerUser('user name', 'password123')).rejects.toThrow(AuthError);
    await expect(registerUser('user@name', 'password123')).rejects.toThrow(AuthError);
    await expect(registerUser('user.name', 'password123')).rejects.toThrow(AuthError);
    await expect(registerUser('user!name', 'password123')).rejects.toThrow(AuthError);
  });
});

// ─── registerUser ───────────────────────────────────────────────────────────

describe('registerUser', () => {
  it('should create a user with correct fields', async () => {
    const user = await registerUser('TestUser', 'password123', {
      realName: 'Test User',
      email: 'test@example.com',
      location: 'Test City',
      accessLevel: 100,
    });

    expect(user.handle).toBe('TestUser');
    expect(user.realName).toBe('Test User');
    expect(user.email).toBe('test@example.com');
    expect(user.location).toBe('Test City');
    expect(user.accessLevel).toBe(100);
    expect(user.passwordHash).toBeDefined();
    expect(user.passwordHash).not.toBe('password123');
    expect(user.totalCalls).toBe(0);
    expect(user.firstLoginAt).toBeInstanceOf(Date);
    expect(user.lastLoginAt).toBeInstanceOf(Date);
  });

  it('should use default accessLevel of 20 when not specified', async () => {
    const user = await registerUser('NewUser', 'password123');
    expect(user.accessLevel).toBe(20);
  });

  it('should set null realName and empty location when not provided', async () => {
    const user = await registerUser('MinUser', 'password123');
    expect(user.realName).toBeNull();
    expect(user.location).toBe('');
  });

  it('should sanitize realName by stripping control characters', async () => {
    const user = await registerUser('SanitUser', 'password123', {
      realName: 'Test\x00User\x1bName',
    });
    expect(user.realName).toBe('TestUserName');
  });

  it('should sanitize location by stripping control characters', async () => {
    const user = await registerUser('LocUser', 'password123', {
      location: 'City\x07Town\x1f',
    });
    expect(user.location).toBe('CityTown');
  });

  it('should truncate realName to 50 characters', async () => {
    const longName = 'A'.repeat(60);
    const user = await registerUser('LongNameUser', 'password123', {
      realName: longName,
    });
    expect(user.realName!.length).toBe(50);
  });

  it('should truncate location to 50 characters', async () => {
    const longLoc = 'B'.repeat(60);
    const user = await registerUser('LongLocUser', 'password123', {
      location: longLoc,
    });
    expect(user.location.length).toBe(50);
  });

  it('should reject duplicate handle', async () => {
    await registerUser('DupeUser', 'password123');
    await expect(registerUser('DupeUser', 'password456')).rejects.toThrow(AuthError);
    await expect(registerUser('DupeUser', 'password456')).rejects.toThrow(
      'Handle "DupeUser" is already taken',
    );
  });

  it('should reject duplicate email', async () => {
    await registerUser('User1', 'password123', { email: 'shared@example.com' });
    await expect(
      registerUser('User2', 'password123', { email: 'shared@example.com' }),
    ).rejects.toThrow(AuthError);
    await expect(
      registerUser('User2', 'password123', { email: 'shared@example.com' }),
    ).rejects.toThrow('Email address is already registered');
  });

  it('should allow multiple users without email (null email)', async () => {
    const user1 = await registerUser('NoEmail1', 'password123');
    const user2 = await registerUser('NoEmail2', 'password123');
    expect(user1.email).toBeNull();
    expect(user2.email).toBeNull();
  });
});

// ─── loginUser ──────────────────────────────────────────────────────────────

describe('loginUser', () => {
  it('should authenticate and return user with incremented totalCalls', async () => {
    await registerUser('LoginTest', 'password123');

    const user = await loginUser('LoginTest', 'password123', '127.0.0.1', 1);
    expect(user.handle).toBe('LoginTest');
    expect(user.totalCalls).toBe(1);
    expect(user.lastLoginFrom).toBe('127.0.0.1');
  });

  it('should increment totalCalls on each login', async () => {
    await registerUser('MultiLogin', 'password123');

    await loginUser('MultiLogin', 'password123', '127.0.0.1', 1);
    // Need to clean up node before second login on same node
    await db.node.deleteMany({ where: { nodeNumber: 1 } });

    const user2 = await loginUser('MultiLogin', 'password123', '127.0.0.1', 1);
    expect(user2.totalCalls).toBe(2);
  });

  it('should not create a lastCaller record (moved to BBS layer for per-player scoping)', async () => {
    await registerUser('CallerTest', 'password123');
    await loginUser('CallerTest', 'password123', '10.0.0.1', 2);

    // lastCaller creation moved to bbs.ts where playerGameId is available
    const callers = await db.lastCaller.findMany({ where: { handle: 'CallerTest' } });
    expect(callers.length).toBe(0);
  });

  it('should upsert a node record', async () => {
    await registerUser('NodeTest', 'password123');
    await loginUser('NodeTest', 'password123', '10.0.0.1', 3);

    const node = await db.node.findUnique({ where: { nodeNumber: 3 } });
    expect(node).not.toBeNull();
    expect(node!.remoteAddress).toBe('10.0.0.1');
    expect(node!.activity).toBe('Main Menu');
    expect(node!.authenticated).toBe(true);
  });

  it('should throw AuthError for wrong password', async () => {
    await registerUser('WrongPW', 'password123');
    await expect(loginUser('WrongPW', 'badpassword', '127.0.0.1', 1)).rejects.toThrow(
      AuthError,
    );
    await expect(loginUser('WrongPW', 'badpassword', '127.0.0.1', 1)).rejects.toThrow(
      'Invalid handle or password',
    );
  });

  it('should throw AuthError for non-existent handle', async () => {
    await expect(
      loginUser('NoSuchUser', 'password123', '127.0.0.1', 1),
    ).rejects.toThrow(AuthError);
    await expect(
      loginUser('NoSuchUser', 'password123', '127.0.0.1', 1),
    ).rejects.toThrow('Invalid handle or password');
  });

  it('should throw AuthError for locked account (accessLevel=0)', async () => {
    await registerUser('LockedUser', 'password123', { accessLevel: 0 });
    await expect(
      loginUser('LockedUser', 'password123', '127.0.0.1', 1),
    ).rejects.toThrow(AuthError);
    await expect(
      loginUser('LockedUser', 'password123', '127.0.0.1', 1),
    ).rejects.toThrow('Account is locked');
  });

  it('should validate handle format before lookup', async () => {
    await expect(loginUser('', 'password123', '127.0.0.1', 1)).rejects.toThrow(
      AuthError,
    );
    await expect(loginUser('a', 'password123', '127.0.0.1', 1)).rejects.toThrow(
      AuthError,
    );
    await expect(
      loginUser('user with spaces', 'password123', '127.0.0.1', 1),
    ).rejects.toThrow(AuthError);
  });
});

// ─── logoutUser ─────────────────────────────────────────────────────────────

describe('logoutUser', () => {
  it('should delete the node record', async () => {
    const user = await registerUser('LogoutTest', 'password123');
    await loginUser('LogoutTest', 'password123', '127.0.0.1', 4);

    // Verify node exists
    const nodeBefore = await db.node.findUnique({ where: { nodeNumber: 4 } });
    expect(nodeBefore).not.toBeNull();

    await logoutUser(user.id, 4);

    // Verify node is deleted
    const nodeAfter = await db.node.findUnique({ where: { nodeNumber: 4 } });
    expect(nodeAfter).toBeNull();
  });

  it('should not throw if user does not exist', async () => {
    // logoutUser should handle gracefully even if user is gone
    await expect(logoutUser(999999, 99)).resolves.not.toThrow();
  });
});

// ─── getUserByHandle / getUserById ──────────────────────────────────────────

describe('getUserByHandle', () => {
  it('should return user when found', async () => {
    await registerUser('FindMe', 'password123');
    const user = await getUserByHandle('FindMe');
    expect(user).not.toBeNull();
    expect(user!.handle).toBe('FindMe');
  });

  it('should return null when not found', async () => {
    const user = await getUserByHandle('GhostUser');
    expect(user).toBeNull();
  });
});

describe('getUserById', () => {
  it('should return user when found', async () => {
    const created = await registerUser('ById', 'password123');
    const user = await getUserById(created.id);
    expect(user).not.toBeNull();
    expect(user!.handle).toBe('ById');
  });

  it('should return null when not found', async () => {
    const user = await getUserById(999999);
    expect(user).toBeNull();
  });
});
