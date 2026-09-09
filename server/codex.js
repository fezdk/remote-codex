import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { randomBytes } from 'node:crypto';
import { messages } from '../public/locales.js';
const bridgeError = errorKey => Object.assign(new Error(messages.en[errorKey]), { errorKey });

export class CodexClient extends EventEmitter {
  constructor({ socketPath, url, token, timeout = 30000, heartbeatMs = 15000 }) {
    super();
    this.options = { socketPath, url, token, timeout };
    this.pending = new Map();
    this.requests = new Map();
    this.subscriptions = new Set();
    this.sequence = 0;
    this.eventSequence = 0;
    this.state = 'disconnected';
    this.stopped = false;
    this.retry = 0;
    this.heartbeatMs = heartbeatMs;
  }

  status() {
    return { state: this.state, error: this.lastError, transport: this.options.url ? 'websocket' : 'unix', platform: this.info?.platformOs };
  }

  connect() {
    if (this.stopped || this.ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws.readyState)) return;
    this.state = 'connecting';
    this.emit('status', this.status());
    const { socketPath, url, token } = this.options;
    const endpoint = url || `ws+unix://${socketPath}:/`;
    const headers = url ? {} : { Host: 'localhost' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const ws = this.ws = new WebSocket(endpoint, { headers, perMessageDeflate: false, handshakeTimeout: 10000, maxPayload: 64 * 1024 * 1024 });
    let alive = true;
    ws.on('pong', () => { alive = true; });
    ws.on('message', bytes => {
      try { this.receive(JSON.parse(bytes.toString())); }
      catch { this.lastError = 'Codex returned an invalid protocol message.'; }
    });
    ws.on('error', error => { this.lastError = error.message; });
    ws.on('open', async () => {
      this.heartbeat = setInterval(() => {
        if (!alive) { ws.terminate(); return; }
        alive = false; ws.ping();
      }, this.heartbeatMs);
      this.heartbeat.unref();
      try {
        this.info = await this.rpc('initialize', {
          clientInfo: { name: 'remote_codex_web', title: 'Remote Codex', version: '0.1.0' },
          capabilities: { experimentalApi: true },
        }, true);
        this.send({ method: 'initialized', params: {} });
        this.lastError = null;
        this.retry = 0;
        for (const threadId of this.subscriptions) {
          if (this.stopped || this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
          try { await this.rpc('thread/resume', { threadId, excludeTurns: true }, true); }
          catch (error) { this.emit('event', { method: 'bridge/subscriptionError', params: { threadId, message: error.message } }); }
        }
        if (this.stopped || this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        this.state = 'connected';
        this.emit('status', this.status());
      } catch (error) {
        this.lastError = error.message;
        ws.close();
      }
    });
    ws.on('close', () => {
      clearInterval(this.heartbeat);
      this.state = 'disconnected';
      this.lastError ||= 'Connection to Codex closed.';
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(bridgeError('error.disconnected'));
      }
      this.pending.clear();
      this.requests.clear();
      this.emit('status', this.status());
      if (!this.stopped) this.reconnectTimer = setTimeout(() => this.connect(), Math.min(1000 * 2 ** this.retry++, 15000));
    });
  }

  send(message) {
    if (this.ws?.readyState !== WebSocket.OPEN) throw bridgeError('error.notConnected');
    this.ws.send(JSON.stringify(message));
  }

  rpc(method, params = {}, initializing = false) {
    if (!initializing && this.state !== 'connected') return Promise.reject(bridgeError('error.notConnected'));
    const id = `web-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(bridgeError('error.timeout'));
      }, this.options.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  receive(message) {
    if (message.method) {
      message.bridgeSequence = ++this.eventSequence;
      if (message.id !== undefined) {
        message.requestToken = randomBytes(24).toString('hex');
        this.requests.set(JSON.stringify(message.id), message);
      }
      if (message.method === 'serverRequest/resolved') this.requests.delete(JSON.stringify(message.params.requestId));
      if (['turn/completed', 'thread/closed'].includes(message.method)) {
        for (const [key, request] of this.requests) {
          if (request.params?.threadId === message.params.threadId && (!message.params.turn || request.params.turnId === message.params.turn.id)) this.requests.delete(key);
        }
      }
      this.emit('event', message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    else pending.resolve(message.result && typeof message.result === 'object' ? { ...message.result, bridgeSequence: this.eventSequence } : message.result);
  }

  async subscribe(threadId) {
    const result = await this.rpc('thread/resume', { threadId, excludeTurns: true });
    this.subscriptions.add(threadId);
    return result;
  }

  respond(id, result) {
    const key = JSON.stringify(id);
    const request = this.requests.get(key);
    if (!request) throw bridgeError('error.noPending');
    this.send({ id: request.id, result });
    this.requests.delete(key);
    this.emit('event', { method: 'serverRequest/resolved', params: { threadId: request.params?.threadId, requestId: request.id } });
  }

  close() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeat);
    this.ws?.close();
  }
}
