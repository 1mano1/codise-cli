// Inferencia remota: "codice serve" comparte los modelos de esta PC; "codice connect" los usa desde otra máquina.
// "codice bench" mide velocidad y soporte de herramientas.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME, VERSION } from './config.js';
import { readJSON, writeJSON, formatTokens } from './util/fs.js';
import { c, style } from './ui/theme.js';
import * as ui from './ui/output.js';
import { OllamaClient } from './llm/ollama.js';
import { OpenAIClient } from './llm/openai.js';
import { RemoteClient, createSingleClient } from './llm/index.js';
import { parseTextToolCalls } from './llm/textTools.js';

const SERVE_FILE = () => path.join(HOME, 'serve.json');

// ── Detección del backend local ──────────────────────────────────
async function probe(url, kind) {
  try {
    const client = kind === 'ollama' ? new OllamaClient({ baseUrl: url }) : new OpenAIClient({ baseUrl: url });
    const models = await client.listModels();
    return { kind, url, models };
  } catch {
    return null;
  }
}

export async function detectBackend({ backend, backendUrl } = {}) {
  if (backendUrl) {
    const kind = backend || (/11434/.test(backendUrl) ? 'ollama' : 'openai');
    return probe(backendUrl, kind);
  }
  const candidates = [
    ['ollama', 'http://localhost:11434'],
    ['openai', 'http://localhost:1234/v1'],
    ['openai', 'http://localhost:8080/v1'],
    ['openai', 'http://localhost:8000/v1'],
    ['openai', 'http://localhost:1337/v1'],
  ].filter(([k]) => !backend || k === backend);
  for (const [kind, url] of candidates) {
    const r = await probe(url, kind);
    if (r) return r;
  }
  return null;
}

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address, tailscale: a.address.startsWith('100.') });
    }
  }
  return out;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ── Servidor ─────────────────────────────────────────────────────
export async function serve(o) {
  const saved = readJSON(SERVE_FILE(), {});
  const token = o.token && o.token !== true ? String(o.token) : saved.token || crypto.randomBytes(24).toString('hex');
  if (token !== saved.token) writeJSON(SERVE_FILE(), { ...saved, token });
  const port = Number(o.port) || saved.port || 8787;
  const host = o.host || '0.0.0.0';

  ui.info('Buscando un servidor de modelos en esta PC…');
  const backend = await detectBackend({ backend: o.backend, backendUrl: o['backend-url'] });
  if (!backend) {
    ui.errorBox('No encontré Ollama, LM Studio, llama.cpp, vLLM ni Jan en esta PC', 'ningún puerto local respondió', 'Inicia tu servidor de modelos (p. ej. "ollama serve") o indica --backend-url http://localhost:PUERTO');
    return 1;
  }
  const target = new URL(backend.url);
  const backendOrigin = target.origin;
  const failures = new Map();

  const handler = (req, res) => {
    const t0 = Date.now();
    const ip = req.socket.remoteAddress?.replace('::ffff:', '') || '?';
    const log = (status) => ui.println(c.dim(`${new Date().toLocaleTimeString()}  ${ip.padEnd(15)} ${req.method} ${req.url.split('?')[0]} ${status} ${((Date.now() - t0) / 1000).toFixed(1)} s`));
    const f = failures.get(ip);
    if (f && f.count >= 10 && Date.now() - f.since < 60000) { res.writeHead(429); res.end('Demasiados intentos'); return log(429); }
    const auth = req.headers.authorization || '';
    if (!safeEqual(auth.replace(/^Bearer\s+/i, ''), token)) {
      const cur = failures.get(ip) || { count: 0, since: Date.now() };
      if (Date.now() - cur.since > 60000) { cur.count = 0; cur.since = Date.now(); }
      cur.count++;
      failures.set(ip, cur);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":"token inválido"}');
      return log(401);
    }
    if (req.url === '/codice/info') {
      detectBackend({ backend: backend.kind, backendUrl: backend.url }).then((b) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: 'codice-serve', version: VERSION, host: os.hostname(), backend: backend.kind, models: (b?.models || []).map((m) => m.id) }));
        log(200);
      });
      return;
    }
    let upstreamPath = null;
    if (backend.kind === 'ollama' && req.url.startsWith('/ollama/')) upstreamPath = req.url.slice('/ollama'.length);
    else if (backend.kind === 'openai' && req.url.startsWith('/openai/')) upstreamPath = req.url.slice('/openai'.length);
    if (!upstreamPath) { res.writeHead(404); res.end('Ruta no encontrada'); return log(404); }
    const headers = { ...req.headers };
    delete headers.authorization;
    delete headers.host;
    const upstream = http.request(`${backendOrigin}${upstreamPath}`, { method: req.method, headers }, (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
      up.on('end', () => log(up.statusCode));
    });
    upstream.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `backend no disponible: ${e.message}` }));
      log(502);
    });
    // si el cliente se desconecta antes de terminar, se corta la generación en el backend
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  };

  const tls = o.cert && o.key;
  const server = tls ? https.createServer({ cert: fs.readFileSync(o.cert), key: fs.readFileSync(o.key) }, handler) : http.createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });

  const scheme = tls ? 'https' : 'http';
  const addrs = lanAddresses();
  const lines = [
    `${c.dim('backend    ')}${c.primary(backend.kind === 'ollama' ? 'Ollama' : 'OpenAI-compatible')} ${c.muted(backend.url)} · ${backend.models.length} modelos`,
    `${c.dim('escuchando ')}${scheme}://${host}:${port}`,
    ...addrs.map((a) => `${c.dim(a.tailscale ? 'tailscale  ' : 'red local  ')}${c.info(`${scheme}://${a.address}:${port}`)}`),
    `${c.dim('token      ')}${c.soft(token)}`,
  ];
  ui.box(lines, { title: c.accent('Códice serve', { bold: true }) });
  const best = addrs.find((a) => a.tailscale) || addrs[0];
  ui.println(c.primary('En tu laptop ejecuta:', { bold: true }));
  ui.println(`  ${c.accent(`codice connect ${scheme}://${best ? best.address : 'IP-DE-ESTA-PC'}:${port} --token ${token} --name pc-casa`)}`);
  ui.println('');
  ui.warn('No abras este puerto a internet. Para usarlo fuera de casa usa Tailscale, ZeroTier o una VPN.');
  if (!tls) ui.hint('Para cifrar el tráfico en la red local usa --cert y --key (HTTPS).');
  ui.hint('Ctrl+C para detener.');
  await new Promise((resolve) => {
    const stop = () => { server.close(); resolve(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

// ── Conectar desde otra máquina ──────────────────────────────────
export async function connect(args, o, rt) {
  const url = args[0];
  const token = o.token && o.token !== true ? String(o.token) : '';
  const name = o.name && o.name !== true ? String(o.name) : 'pc-remota';
  if (!url || !token) { console.error('Uso: codice connect http://IP:8787 --token TOKEN [--name pc-casa] [--model modelo]'); return 2; }
  const client = new RemoteClient({ baseUrl: url, apiKey: token, label: name });
  let info;
  try {
    info = await client.info();
  } catch (e) {
    ui.errorBox(`No pude conectar con ${url}`, e.message, '¿Está corriendo "codice serve" en la PC? ¿Misma red o Tailscale activo? ¿Token correcto?');
    return 1;
  }
  rt.save(`providers.${name}`, { type: 'codice', baseUrl: url.replace(/\/+$/, ''), apiKey: token, label: `${name} (${info.host})` });
  ui.success(`Conectado a ${info.host} · backend ${info.backend} · ${info.models.length} modelos`);
  for (const m of info.models.slice(0, 15)) ui.println(`  ${c.dim('·')} ${m}`);
  const model = o.model && o.model !== true ? String(o.model) : info.models.find((m) => /coder|code/i.test(m)) || info.models[0];
  if (o.default !== false) {
    rt.save('provider', name);
    if (model) rt.save('model', model);
    ui.success(`Proveedor por defecto: ${name}${model ? ` · modelo ${model}` : ''}`);
  }
  ui.hint(`Si la PC no está disponible, configura un respaldo: codice config set fallback '["ollama:qwen2.5-coder:7b"]'`);
  return 0;
}

// ── Benchmark ────────────────────────────────────────────────────
const BENCH_TOOL = { name: 'get_weather', description: 'Get the current weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };

export async function benchModel(settings, provider, model) {
  const client = createSingleClient(settings, provider, model);
  const result = { model, ttft: null, tps: null, tools: '✗', error: null };
  try {
    const t0 = Date.now();
    let first = null;
    const r = await client.chat({
      messages: [{ role: 'user', content: 'Write a JavaScript function that reverses a string. Code only.' }],
      onText: () => { first ??= Date.now(); },
      onReasoning: () => { first ??= Date.now(); },
      maxTokens: 200,
    });
    const end = Date.now();
    result.ttft = first ? first - t0 : end - t0;
    const out = r.usage?.output || Math.round(r.content.length / 4);
    const genMs = r.usage?.evalDurationNs ? r.usage.evalDurationNs / 1e6 : end - (first || t0);
    result.tps = genMs > 0 ? out / (genMs / 1000) : null;
  } catch (e) {
    result.error = e.message;
    return result;
  }
  try {
    const r = await client.chat({ messages: [{ role: 'user', content: 'What is the weather in Madrid? Use the tool.' }], tools: [BENCH_TOOL], maxTokens: 200 });
    if (r.toolCalls?.some((t) => t.name === 'get_weather')) result.tools = 'nativas';
    else if (parseTextToolCalls(r.content).calls.length) result.tools = 'prompt';
  } catch (e) {
    if (e.toolsUnsupported) result.tools = 'prompt';
  }
  if (result.tools !== 'nativas') {
    // probar el formato de texto
    try {
      const { toolsPrompt } = await import('./llm/textTools.js');
      const r = await client.chat({ messages: [{ role: 'system', content: toolsPrompt([BENCH_TOOL]) }, { role: 'user', content: 'What is the weather in Madrid? Use the tool.' }], maxTokens: 200 });
      if (parseTextToolCalls(r.content).calls.length) result.tools = 'prompt';
    } catch { /* sin soporte */ }
  }
  return result;
}

export async function bench(args, o, rt) {
  const provider = rt.settings.provider;
  let models = o.models && o.models !== true ? String(o.models).split(',') : args.length ? args : null;
  if (!models) {
    try {
      models = (await rt.createClient({ model: rt.settings.model || 'x' }).listModels()).map((m) => m.id);
    } catch (e) {
      ui.errorBox(`No se pudo conectar con ${provider}`, e.message, 'Revisa /provider o /doctor');
      return 1;
    }
  }
  if (!models.length) { ui.warn('No hay modelos para medir.'); return 1; }
  ui.println(c.primary(`Benchmark en ${provider} · ${models.length} modelo${models.length === 1 ? '' : 's'}`, { bold: true }));
  ui.println(c.dim(`${'modelo'.padEnd(34)}${'1er token'.padEnd(12)}${'tokens/s'.padEnd(11)}herramientas`));
  const modesFile = path.join(HOME, 'tool-modes.json');
  const modes = readJSON(modesFile, {});
  for (const model of models) {
    rt.spinner.start(`Midiendo ${model}…`);
    const r = await benchModel(rt.settings, provider, model);
    rt.spinner.stop();
    if (r.error) { ui.println(`${model.padEnd(34)}${c.error(`✗ ${r.error.slice(0, 60)}`)}`); continue; }
    const tools = r.tools === 'nativas' ? c.success('● nativas') : r.tools === 'prompt' ? c.warning('◇ modo prompt') : c.error('✗ no');
    ui.println(`${style(model.padEnd(34), { fg: 'text/primary' })}${c.muted(`${(r.ttft / 1000).toFixed(2)} s`.padEnd(12))}${c.soft((r.tps ? r.tps.toFixed(1) : '?').padEnd(11))}${tools}`);
    if (r.tools === 'prompt') modes[model] = 'prompt';
    if (r.tools === 'nativas') modes[model] = 'native';
  }
  writeJSON(modesFile, modes);
  ui.hint('El modo de herramientas detectado se guarda para usarlo automáticamente.');
  return 0;
}

export async function runRemote(sub, args, o, rt) {
  if (sub === 'serve') return serve(o);
  if (sub === 'connect') return connect(args, o, rt);
  if (sub === 'bench') return bench(args, o, rt);
  return 2;
}

export { formatTokens };
