import { homedir, networkInterfaces } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAccessKey } from './credential-store.js';
import { CodexClient } from './codex.js';
import { createWebServer } from './http.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.REMOTE_CODEX_HOST || '0.0.0.0';
const port = Number(process.env.REMOTE_CODEX_PORT || 4310);
const origin = process.env.REMOTE_CODEX_ORIGIN;
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid REMOTE_CODEX_PORT.');
if (origin && new URL(origin).origin !== origin) throw new Error('REMOTE_CODEX_ORIGIN must be an exact origin without a trailing slash.');
let token = process.env.REMOTE_CODEX_TOKEN;
if (!token) {
  const stateDir = resolve(root, '.remote-codex');
  const tokenPath = resolve(stateDir, 'access-key');
  token = await loadAccessKey(stateDir);
  console.log(`Access key: stored in ${tokenPath}`);
}
if (token.length < 24) throw new Error('Use an access key of at least 24 characters.');
const upstream = process.env.CODEX_APP_SERVER_URL;
if (upstream) {
  const url = new URL(upstream);
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('CODEX_APP_SERVER_URL must use ws:// or wss://.');
  if (url.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Use wss:// for a remote Codex server.');
}
const codex = new CodexClient({
  socketPath: process.env.CODEX_APP_SERVER_SOCKET || resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'), 'app-server-control/app-server-control.sock'),
  url: upstream,
  token: process.env.CODEX_APP_SERVER_TOKEN,
});
const server = createWebServer({ codex, token, origin, publicDir: resolve(root, 'public') });
server.on('error', error => { console.error(error.message); codex.close(); process.exitCode = 1; });
server.listen(port, host, () => {
  console.log(`Remote Codex: ${origin || `http://${host === '::1' ? '[::1]' : host}:${port}`}`);
  if (host === '0.0.0.0') {
    for (const address of Object.values(networkInterfaces()).flat()) {
      if (address.family === 'IPv4' && !address.internal) console.log(`Network access: http://${address.address}:${port}`);
    }
  }
  codex.connect();
});
let previousState;
codex.on('status', status => {
  if (status.state !== previousState) console.log(`Codex: ${status.state}${status.error ? ` (${status.error})` : ''}`);
  previousState = status.state;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  codex.close(); server.closeStreams(); server.close();
  setTimeout(() => process.exit(), 2000).unref();
});
