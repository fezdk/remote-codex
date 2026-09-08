import http from 'node:http';
import { messages } from '../public/locales.js';
import { codexChanges, gitChanges, gitFileDiff } from './changes.js';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { resolve, isAbsolute } from 'node:path';
import { networkInterfaces } from 'node:os';

const cookieName = 'remote_codex_session';
const mime = { '/': 'text/html; charset=utf-8', '/app.js': 'text/javascript; charset=utf-8', '/state.js': 'text/javascript; charset=utf-8', '/style.css': 'text/css; charset=utf-8', '/icon.svg': 'image/svg+xml' };
for (const name of ['preferences.js', 'i18n.js', 'locales.js', 'changes.js', 'queue.js']) mime[`/${name}`] = 'text/javascript; charset=utf-8';
const idOK = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
const fail = (errorKey, status = 400) => Object.assign(new Error(messages.en[errorKey] || errorKey), { status, errorKey });
const equal = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

async function body(req) {
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 1024 * 1024) throw fail('error.tooLarge', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw fail('error.json'); }
}

export function approvalResult(request, input) {
  const method = request.method;
  if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) {
    // Only one-off approvals: never silently amend persistent rules or session permissions.
    if (!['accept', 'decline', 'cancel'].includes(input.decision)) throw fail('error.decision');
    const allowed = request.params.availableDecisions;
    if (allowed && !allowed.includes(input.decision)) throw fail('error.decisionUnavailable');
    return { decision: input.decision };
  }
  if (method === 'item/tool/requestUserInput') {
    const answers = Object.create(null);
    for (const question of request.params.questions) {
      const value = input.answers?.[question.id];
      if (typeof value !== 'string' || !value.trim() || value.length > 20000) throw fail('error.answers');
      answers[question.id] = { answers: [value] };
    }
    return { answers };
  }
  throw fail('error.unsupportedRequest', 422);
}

export function createWebServer({ codex, token, publicDir, origin, defaultCwd = process.cwd() }) {
  const sessions = new Map();
  const streams = new Map();
  const attempts = new Map();
  let eventId = 0;
  const sendEvent = (res, type, data) => {
    if (res.writableLength > 2 * 1024 * 1024) return res.destroy();
    res.write(`id: ${++eventId}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const broadcast = (type, data) => { for (const res of streams.keys()) sendEvent(res, type, data); };
  const onEvent = data => broadcast('codex', data);
  const onStatus = data => broadcast('status', data);
  codex.on('event', onEvent);
  codex.on('status', onStatus);
  const server = http.createServer(async (req, res) => {
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const configured = new URL(origin || `http://127.0.0.1:${server.address().port}`);
      const localHosts = [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`, `[::1]:${server.address().port}`];
      for (const address of Object.values(networkInterfaces()).flat()) {
        const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
        localHosts.push(`${host}:${server.address().port}`);
      }
      const hostAllowed = origin ? req.headers.host === configured.host : localHosts.includes(req.headers.host);
      if (!hostAllowed) throw fail('error.host', 403);
      const expectedOrigin = origin || `http://${req.headers.host}`;
      if (req.headers.origin && req.headers.origin !== expectedOrigin) throw fail('error.crossOrigin', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw fail('error.crossSite', 403);
      const url = new URL(req.url, expectedOrigin);
      const path = url.pathname;
      if (req.method === 'GET' && Object.hasOwn(mime, path)) {
        const file = path === '/' ? 'index.html' : path.slice(1);
        res.writeHead(200, { 'Content-Type': mime[path] });
        res.end(await readFile(resolve(publicDir, file)));
        return;
      }
      const sessionId = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      const expires = sessions.get(sessionId);
      const authenticated = expires && expires > Date.now();
      const secureCookie = configured.protocol === 'https:' ? '; Secure' : '';
      if (path === '/api/login' && req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) throw fail('error.jsonRequired', 415);
        const remote = req.socket.remoteAddress;
        let attempt = attempts.get(remote);
        if (!attempt || attempt.until < Date.now()) { attempt = { count: 0, until: Date.now() + 60000 }; attempts.set(remote, attempt); }
        if (++attempt.count > 10) throw fail('error.rateLimit', 429);
        const input = await body(req);
        if (typeof input.token !== 'string' || !equal(input.token, token)) throw fail('error.key', 401);
        const id = randomBytes(32).toString('hex');
        sessions.set(id, Date.now() + 12 * 60 * 60 * 1000);
        res.setHeader('Set-Cookie', `${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secureCookie}`);
        json(200, { ok: true }); return;
      }
      if (!authenticated) throw fail('error.login', 401);
      if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json')) throw fail('error.jsonRequired', 415);
      if (path === '/api/logout' && req.method === 'POST') {
        sessions.delete(sessionId);
        for (const [stream, id] of streams) if (id === sessionId) { stream.end(); streams.delete(stream); }
        res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie}`);
        json(200, { ok: true }); return;
      }
      if (path === '/api/status' && req.method === 'GET') {
        json(200, { ...codex.status(), defaultCwd }); return;
      }
      if (path === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        streams.set(res, sessionId);
        sendEvent(res, 'status', codex.status());
        sendEvent(res, 'pending', [...codex.requests.values()]);
        sendEvent(res, 'resync', {});
        req.on('close', () => streams.delete(res));
        return;
      }
      if (path === '/api/threads' && req.method === 'GET') {
        const result = await codex.rpc('thread/list', {
          limit: 50, sortKey: 'updated_at', sortDirection: 'desc', useStateDbOnly: true,
          modelProviders: [], sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
          ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor') } : {}),
          ...(url.searchParams.get('search') ? { searchTerm: url.searchParams.get('search').slice(0,300) } : {}),
        });
        json(200, result); return;
      }
      if (path === '/api/threads' && req.method === 'POST') {
        const input = await body(req);
        if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd)) throw fail('error.path');
        const result = await codex.rpc('thread/start', { cwd: input.cwd });
        codex.subscriptions.add(result.thread.id);
        json(201, result); return;
      }
      const match = path.match(/^\/api\/threads\/([^/]+)\/(open|turns|message|interrupt|changes|git|git-diff|queue)$/);
      if (match) {
        const [, threadId, action] = match;
        if (!idOK(threadId)) throw fail('error.sessionId');
        if (['changes', 'git', 'git-diff'].includes(action) && req.method === 'GET') {
          if (action === 'changes') { json(200, await codexChanges(codex, threadId)); return; }
          const upstream = codex.options?.url;
          if (upstream && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(upstream).hostname)) throw fail('changes.remoteGit', 422);
          const { thread } = await codex.rpc('thread/read', { threadId });
          json(200, action === 'git' ? await gitChanges(thread.cwd) : await gitFileDiff(thread.cwd, url.searchParams.get('path'))); return;
        }
        if (action === 'queue' && req.method === 'GET') {
          const data = []; let cursor;
          do {
            const page = await codex.rpc('thread/queue/list', { threadId, limit: 100, ...(cursor ? { cursor } : {}) });
            data.push(...page.data); cursor = page.nextCursor;
          } while (cursor && data.length < 1000);
          json(200, { data, nextCursor: cursor || null }); return;
        }
        if (action === 'queue' && req.method === 'POST') {
          const input = await body(req);
          if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 100000) throw fail('error.message');
          if (!codex.subscriptions.has(threadId)) throw fail('error.openSession', 409);
          if (!idOK(input.clientId)) throw fail('error.message');
          json(200, await codex.rpc('thread/queue/add', { threadId, clientUserMessageId: input.clientId, input: [{ type: 'text', text: input.text, text_elements: [] }] })); return;
        }
        if (action === 'open' && req.method === 'POST') { json(200, await codex.subscribe(threadId)); return; }
        if (action === 'turns' && req.method === 'GET') {
          json(200, await codex.rpc('thread/turns/list', { threadId, limit: 20, itemsView: 'full', sortDirection: 'desc', ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor') } : {}) })); return;
        }
        if (action === 'message' && req.method === 'POST') {
          const input = await body(req);
          if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 100000) throw fail('error.message');
          if (!codex.subscriptions.has(threadId)) throw fail('error.openSession', 409);
          const params = { threadId, input: [{ type: 'text', text: input.text, text_elements: [] }] };
          if (input.turnId != null) {
            if (!idOK(input.turnId)) throw fail('error.turnId');
            params.expectedTurnId = input.turnId;
          }
          json(200, await codex.rpc(input.turnId ? 'turn/steer' : 'turn/start', params)); return;
        }
        if (action === 'interrupt' && req.method === 'POST') {
          const input = await body(req);
          if (!idOK(input.turnId)) throw fail('error.activeTurn');
          json(200, await codex.rpc('turn/interrupt', { threadId, turnId: input.turnId })); return;
        }
      }
      const queued = path.match(/^\/api\/threads\/([^/]+)\/queue\/([^/]+)\/(delete|start)$/);
      if (queued && req.method === 'POST') {
        const [, threadId, queuedSubmissionId, action] = queued;
        if (!idOK(threadId) || !idOK(queuedSubmissionId)) throw fail('error.sessionId');
        if (!codex.subscriptions.has(threadId)) throw fail('error.openSession', 409);
        json(200, await codex.rpc(`thread/queue/${action}`, { threadId, queuedSubmissionId })); return;
      }
      if (path === '/api/respond' && req.method === 'POST') {
        const input = await body(req);
        const request = codex.requests.get(JSON.stringify(input.id));
        if (!request) throw fail('error.resolved', 409);
        codex.respond(input.id, approvalResult(request, input));
        json(200, { ok: true }); return;
      }
      throw fail('error.notFound', 404);
    } catch (error) {
      if (!res.headersSent) json(error.status || 502, { error: error.message, ...(error.errorKey ? { errorKey: error.errorKey } : {}) });
      else res.end();
    }
  });
  const heartbeat = setInterval(() => {
    for (const [res, id] of streams) {
      if (!sessions.has(id) || sessions.get(id) < Date.now()) { res.end(); streams.delete(res); }
      else res.write(': heartbeat\n\n');
    }
    for (const [id, expiry] of sessions) if (expiry < Date.now()) sessions.delete(id);
    for (const [ip, attempt] of attempts) if (attempt.until < Date.now()) attempts.delete(ip);
  }, 15000);
  heartbeat.unref();
  server.on('close', () => { clearInterval(heartbeat); codex.off('event', onEvent); codex.off('status', onStatus); });
  server.closeStreams = () => { for (const res of streams.keys()) res.end(); streams.clear(); };
  return server;
}
