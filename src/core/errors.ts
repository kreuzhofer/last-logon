export class BBSError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = 'BBSError';
  }
}

export class AuthError extends BBSError {
  constructor(message: string) {
    super(message, 'AUTH_ERROR');
    this.name = 'AuthError';
  }
}

export class SessionError extends BBSError {
  constructor(message: string) {
    super(message, 'SESSION_ERROR');
    this.name = 'SessionError';
  }
}

export class DatabaseError extends BBSError {
  constructor(message: string) {
    super(message, 'DB_ERROR');
    this.name = 'DatabaseError';
  }
}

export class ConnectionError extends BBSError {
  constructor(message: string) {
    super(message, 'CONNECTION_ERROR');
    this.name = 'ConnectionError';
  }
}

export class MenuError extends BBSError {
  constructor(message: string) {
    super(message, 'MENU_ERROR');
    this.name = 'MenuError';
  }
}
