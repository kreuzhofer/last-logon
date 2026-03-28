import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

const keyPath = resolve(PROJECT_ROOT, 'config/ssh_host_key');

if (existsSync(keyPath)) {
  console.log('SSH host key already exists at:', keyPath);
  console.log('Delete it first if you want to regenerate.');
  process.exit(0);
}

// Ensure config directory exists
mkdirSync(dirname(keyPath), { recursive: true });

console.log('Generating SSH host key (ed25519)...');

// Use ssh-keygen which produces the correct OpenSSH format that ssh2 expects
execSync(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`);

console.log('SSH host key generated:');
console.log('  Private:', keyPath);
console.log('  Public:', keyPath + '.pub');
