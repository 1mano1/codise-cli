// Cliente MCP (Model Context Protocol): transportes stdio y HTTP, herramientas y prompts.
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sse } from './llm/stream.js';
import { VERSION } from './config.js';
import { L } from './i18n.js';

const PROTOCOL = '2025-06-18';

function subEnv(v) {
  return typeof v === 'string' ? v.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? '') : v;
}

function quoteArg(a) {
  return /[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

class StdioTransport {
  constructor(cfg, { cwd }) {
    this.cfg = cfg;
    this.cwd = cwd;
    this.pending = new Map();
    this.stderr = '';
    this.onRequest = null;
  }

  async start() {
    const env = { ...process.env };
    for (const [k, v] of Object.entries(this.cfg.env || {})) env[k] = subEnv(v);
    const cmd = subEnv(this.cfg.command);
    const args = (this.cfg.args || []).map(subEnv);
    // en Windows, npx/uvx/etc. son .cmd: se lanzan a través del shell
    this.proc = process.platform === 'win32'
      ? spawn([cmd, ...args].map(quoteArg).join(' '), { cwd: this.cfg.cwd || this.cwd, env, shell: true, windowsHide: true })
      : spawn(cmd, args, { cwd: this.cfg.cwd || this.cwd, env });
    let buf = '';
    this.proc.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        this.handle(msg);
      }
    });
    this.proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    this.proc.stdin.on('error', () => {});
    await new Promise((resolve, reject) => {
      this.proc.once('spawn', resolve);
      this.proc.once('error', reject);
    });
    this.proc.on('exit', (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(L(`El servidor MCP terminó (código ${code}). ${this.stderr.trim().split('\n').pop() || ''}`, `The MCP server exited (code ${code}). ${this.stderr.trim().split('\n').pop() || ''}`)));
      this.pending.clear();
      this.exited = true;
    });
  }

  handle(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'Error MCP'));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id !== undefined) {
      Promise.resolve(this.onRequest?.(msg))
        .then((result) => this.write({ jsonrpc: '2.0', id: msg.id, result: result ?? {} }))
        .catch((e) => this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: e.message } }));
    }
  }

  write(obj) {
    if (!this.exited) this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  request(msg, timeout) {
    return new Promise((resolve, reject) => {
      if (this.exited) return reject(new Error(L('El servidor MCP no está en ejecución', 'The MCP server is not running')));
      const t = setTimeout(() => { this.pending.delete(msg.id); reject(new Error(L(`Tiempo de espera agotado (${msg.method})`, `Timed out (${msg.method})`))); }, timeout);
      this.pending.set(msg.id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.write(msg);
    });
  }

  notify(msg) { this.write(msg); }

  close() {
    try { this.proc?.kill(); } catch { /* ya cerrado */ }
  }
}

class HttpTransport {
  constructor(cfg) {
    this.url = subEnv(cfg.url);
    this.headers = Object.fromEntries(Object.entries(cfg.headers || {}).map(([k, v]) => [k, subEnv(v)]));
    this.sessionId = null;
  }

  async start() {}

  async post(msg, timeout) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL, ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}), ...this.headers },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(timeout),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    return res;
  }

  async request(msg, timeout) {
    const res = await this.post(msg, timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const ct = res.headers.get('content-type') || '';
    let reply = null;
    if (ct.includes('text/event-stream')) {
      for await (const data of sse(res.body)) {
        try {
          const j = JSON.parse(data);
          if (j.id === msg.id) { reply = j; break; }
        } catch { /* evento no JSON */ }
      }
    } else reply = await res.json();
    if (!reply) throw new Error(L('Respuesta MCP vacía', 'Empty MCP response'));
    if (reply.error) throw new Error(reply.error.message || 'Error MCP');
    return reply.result;
  }

  async notify(msg) {
    try { await this.post(msg, 10000); } catch { /* las notificaciones no esperan respuesta */ }
  }

  close() {}
}

export function sanitizeToolName(s) {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

export class McpClient {
  constructor(name, cfg, { cwd }) {
    this.name = name;
    this.cfg = cfg;
    this.cwd = cwd;
    this.nextId = 1;
    this.tools = [];
    this.prompts = [];
    this.status = 'pendiente';
    this.error = null;
  }

  async connect(timeout = 30000) {
    const type = this.cfg.type || (this.cfg.url ? 'http' : 'stdio');
    this.transport = type === 'stdio' ? new StdioTransport(this.cfg, { cwd: this.cwd }) : new HttpTransport(this.cfg);
    this.transport.onRequest = (msg) => {
      if (msg.method === 'ping') return {};
      if (msg.method === 'roots/list') return { roots: [{ uri: pathToFileURL(this.cwd).href, name: 'workspace' }] };
      throw new Error(`Method not supported: ${msg.method}`);
    };
    try {
      await this.transport.start();
      const init = await this.request('initialize', { protocolVersion: PROTOCOL, capabilities: { roots: {} }, clientInfo: { name: 'codice', version: VERSION } }, timeout);
      this.serverInfo = init.serverInfo;
      this.capabilities = init.capabilities || {};
      await this.transport.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
      this.tools = await this.listAll('tools/list', 'tools').catch(() => []);
      if (this.capabilities.prompts) this.prompts = await this.listAll('prompts/list', 'prompts').catch(() => []);
      this.status = 'conectado';
    } catch (e) {
      this.status = 'error';
      this.error = e.message;
      this.transport.close();
    }
    return this;
  }

  async listAll(method, key) {
    const out = [];
    let cursor;
    do {
      const r = await this.request(method, cursor ? { cursor } : {});
      out.push(...(r[key] || []));
      cursor = r.nextCursor;
    } while (cursor && out.length < 1000);
    return out;
  }

  request(method, params, timeout = 120000) {
    return this.transport.request({ jsonrpc: '2.0', id: this.nextId++, method, params }, timeout);
  }

  async callTool(name, args, signal) {
    const p = this.request('tools/call', { name, arguments: args });
    const r = signal ? await Promise.race([p, new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error(L('Interrumpido', 'Interrupted')), { name: 'AbortError' })), { once: true }))]) : await p;
    const parts = (r.content || []).map((c) => {
      if (c.type === 'text') return c.text;
      if (c.type === 'resource') return c.resource?.text || `[recurso ${c.resource?.uri}]`;
      if (c.type === 'image') return `[imagen ${c.mimeType}]`;
      return `[${c.type}]`;
    });
    if (r.structuredContent && !parts.length) parts.push(JSON.stringify(r.structuredContent, null, 2));
    return { text: parts.join('\n') || '(sin contenido)', isError: Boolean(r.isError) };
  }

  async getPrompt(name, args) {
    const r = await this.request('prompts/get', { name, arguments: args });
    return (r.messages || []).map((m) => (m.content?.type === 'text' ? m.content.text : '')).join('\n\n');
  }

  close() {
    this.transport?.close();
  }
}

export class McpManager {
  constructor({ cwd }) {
    this.cwd = cwd;
    this.clients = new Map();
  }

  async startAll(configs) {
    const entries = Object.entries(configs || {}).filter(([, c]) => !c.disabled);
    await Promise.all(entries.map(async ([name, cfg]) => {
      const client = new McpClient(name, cfg, { cwd: this.cwd });
      this.clients.set(name, client);
      await client.connect(cfg.timeout || 30000);
    }));
  }

  async restart(name, cfg) {
    this.clients.get(name)?.close();
    const client = new McpClient(name, cfg, { cwd: this.cwd });
    this.clients.set(name, client);
    await client.connect(cfg.timeout || 30000);
    return client;
  }

  tools() {
    const out = [];
    for (const client of this.clients.values()) {
      if (client.status !== 'conectado') continue;
      for (const t of client.tools) {
        const fullName = sanitizeToolName(`mcp__${client.name}__${t.name}`);
        const readOnly = Boolean(t.annotations?.readOnlyHint);
        out.push({
          name: fullName,
          mcp: { server: client.name, tool: t.name },
          readOnly,
          description: `${t.description || t.name} (servidor MCP "${client.name}")`,
          parameters: t.inputSchema && t.inputSchema.type ? t.inputSchema : { type: 'object', properties: {} },
          summary: (a) => JSON.stringify(a).slice(0, 100),
          permissionKey: () => null,
          async run(args, ctx) {
            const r = await client.callTool(t.name, args, ctx.signal);
            const first = r.text.split('\n')[0].slice(0, 120);
            return { content: r.text, display: r.isError ? first : first || 'Hecho', isError: r.isError };
          },
        });
      }
    }
    return out;
  }

  prompts() {
    const out = [];
    for (const client of this.clients.values()) {
      if (client.status !== 'conectado') continue;
      for (const p of client.prompts) out.push({ name: `mcp__${client.name}__${p.name}`, description: p.description || '', client, prompt: p });
    }
    return out;
  }

  status() {
    return [...this.clients.values()].map((c) => ({ name: c.name, status: c.status, error: c.error, tools: c.tools.length, server: c.serverInfo?.name || '' }));
  }

  stopAll() {
    for (const c of this.clients.values()) c.close();
  }
}
