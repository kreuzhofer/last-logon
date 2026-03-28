import { readFileSync, existsSync } from 'node:fs';
import ssh2 from 'ssh2';
const { Server } = ssh2;
type SSHClientConnection = ssh2.Connection;
import { getConfig } from '../core/config.js';
import { createChildLogger } from '../core/logger.js';
import { SSHConnection, allocateNodeNumber } from './connection.js';
import { eventBus } from '../core/events.js';

const log = createChildLogger('ssh-server');

export type ConnectionHandler = (conn: SSHConnection) => void;

export function createSSHServer(onConnection: ConnectionHandler): Server {
  const config = getConfig();
  const hostKeyPath = config.servers.ssh.hostKeyPath;

  if (!existsSync(hostKeyPath)) {
    throw new Error(
      `SSH host key not found at ${hostKeyPath}. Run: npm run generate-keys`,
    );
  }

  const hostKey = readFileSync(hostKeyPath);

  const server = new Server(
    {
      hostKeys: [hostKey],
      banner: `${config.general.bbsName} - ${config.general.tagline}\r\n`,
    },
    (client: SSHClientConnection) => {
      const clientAddr =
        (client as unknown as { _sock?: { remoteAddress?: string } })._sock
          ?.remoteAddress ?? 'unknown';
      log.info({ remoteAddress: clientAddr }, 'Client connected');

      let authUsername = '';

      client.on('authentication', (ctx) => {
        // For BBS, we accept any password at SSH level
        // Real auth happens in the BBS login flow
        authUsername = ctx.username;

        if (ctx.method === 'password' || ctx.method === 'none') {
          ctx.accept();
        } else if (ctx.method === 'publickey') {
          // Accept all pubkeys at SSH level; BBS auth handles the rest
          ctx.accept();
        } else {
          ctx.reject(['password', 'publickey', 'none']);
        }
      });

      client.on('ready', () => {
        log.info({ remoteAddress: clientAddr, username: authUsername }, 'Client authenticated');

        client.on('session', (accept) => {
          const session = accept();

          let ptyInfo: {
            cols: number;
            rows: number;
            term: string;
          } = { cols: 80, rows: 25, term: 'xterm' };

          session.on('pty', (accept, _reject, info) => {
            ptyInfo = {
              cols: info.cols,
              rows: info.rows,
              term: info.term,
            };
            accept?.();
          });

          session.on('window-change', (_accept, _reject, info) => {
            // Will be connected to SSHConnection after shell is opened
            if (currentConn) {
              currentConn.handleResize(info.cols, info.rows);
            }
          });

          let currentConn: SSHConnection | null = null;

          session.on('shell', (accept) => {
            const stream = accept();

            const nodeNumber = allocateNodeNumber(config.general.maxNodes);
            if (nodeNumber === null) {
              stream.write(
                '\r\n*** All nodes are busy. Please try again later. ***\r\n',
              );
              stream.close();
              return;
            }

            const conn = new SSHConnection(nodeNumber, clientAddr, stream, {
              width: ptyInfo.cols,
              height: ptyInfo.rows,
              term: ptyInfo.term,
            });
            currentConn = conn;

            log.info(
              {
                nodeNumber,
                remoteAddress: clientAddr,
                terminal: ptyInfo.term,
                size: `${ptyInfo.cols}x${ptyInfo.rows}`,
              },
              'Shell session started',
            );

            eventBus.emit('node:activity', {
              nodeNumber,
              activity: 'Connected',
            });

            onConnection(conn);
          });
        });
      });

      client.on('error', (err) => {
        log.warn({ error: err.message, remoteAddress: clientAddr }, 'Client error');
      });

      client.on('close', () => {
        log.info({ remoteAddress: clientAddr }, 'Client disconnected');
      });
    },
  );

  return server;
}

export function startSSHServer(onConnection: ConnectionHandler): Promise<Server> {
  const config = getConfig();
  const server = createSSHServer(onConnection);

  return new Promise((resolve, reject) => {
    server.listen(config.servers.ssh.port, config.servers.ssh.address, () => {
      log.info(
        {
          port: config.servers.ssh.port,
          address: config.servers.ssh.address,
        },
        'SSH server listening',
      );
      resolve(server);
    });

    server.on('error', (err) => {
      log.error({ error: err }, 'SSH server error');
      reject(err);
    });
  });
}
