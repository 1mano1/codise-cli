// Motor local (llama.cpp): lo encuentra o lo descarga, y arranca/apaga llama-server según el modelo elegido.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { HOME } from '../config.js';
import { modelDirs } from './models.js';
import { L } from '../i18n.js';

// Versión fija y probada (no la última publicada).
export const LLAMA_VERSION = 'b11381';
const EXE = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

export function engineDir() {
  return path.join(HOME, 'bin', 'llama.cpp');
}

// Paquetes a descargar según el sistema; el primero usa GPU cuando se puede.
export function enginePackages() {
  const v = LLAMA_VERSION;
  const base = `https://github.com/ggml-org/llama.cpp/releases/download/${v}`;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'win32') return [{ variant: 'vulkan', url: `${base}/llama-${v}-bin-win-vulkan-x64.zip` }, { variant: 'cpu', url: `${base}/llama-${v}-bin-win-cpu-x64.zip` }];
  if (process.platform === 'darwin') return [{ variant: 'metal', url: `${base}/llama-${v}-bin-macos-${arch}.tar.gz` }];
  return [{ variant: 'vulkan', url: `${base}/llama-${v}-bin-ubuntu-vulkan-${arch}.tar.gz` }, { variant: 'cpu', url: `${base}/llama-${v}-bin-ubuntu-${arch}.tar.gz` }];
}

function findExe(dir, depth = 4) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) if (e.isFile() && e.name === EXE) return path.join(dir, e.name);
  if (depth <= 0) return null;
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'blobs') continue;
    const r = findExe(path.join(dir, e.name), depth - 1);
    if (r) return r;
  }
  return null;
}

const variantOf = (p) => (/cpu/i.test(p) ? 'cpu' : /vulkan/i.test(p) ? 'vulkan' : /cuda/i.test(p) ? 'cuda' : 'gpu');

// Binarios de llama-server disponibles, los de GPU primero.
export function findEngines(settings = {}) {
  const found = [];
  const add = (p) => { if (p && fs.existsSync(p) && !found.some((f) => f.path.toLowerCase() === p.toLowerCase())) found.push({ path: p, variant: variantOf(p) }); };
  add(settings.local?.serverPath);
  for (const pkg of enginePackages()) add(findExe(path.join(engineDir(), pkg.variant)));
  for (const d of modelDirs(settings)) {
    if (d.includes('huggingface')) continue;
    for (const sub of ['llama.cpp', 'llama-cpp', 'bin']) {
      const base = path.join(d, sub);
      if (!fs.existsSync(base)) continue;
      for (const v of ['vulkan', 'cuda', 'metal', 'cpu', '']) add(findExe(path.join(base, v), 3));
    }
  }
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['llama-server'], { encoding: 'utf8' });
  if (which.status === 0) add(which.stdout.split(/\r?\n/)[0].trim());
  return found.sort((a, b) => (a.variant === 'cpu') - (b.variant === 'cpu'));
}

async function download(url, dest, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(dest);
  let done = 0;
  for await (const chunk of res.body) {
    done += chunk.length;
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    onProgress?.(done, total);
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
}

function extract(archive, dir) {
  fs.mkdirSync(dir, { recursive: true });
  // En Windows el tar del sistema (bsdtar) abre .zip; en Mac/Linux los paquetes son .tar.gz.
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const args = archive.endsWith('.zip') ? ['-xf', archive, '-C', dir] : ['-xzf', archive, '-C', dir];
  const r = spawnSync(tar, args, { encoding: 'utf8' });
  if (r.status !== 0 && archive.endsWith('.zip') && process.platform === 'win32') {
    const ps = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${archive}' -DestinationPath '${dir}'`], { encoding: 'utf8' });
    if (ps.status !== 0) throw new Error(ps.stderr || 'No se pudo extraer el archivo');
  } else if (r.status !== 0) throw new Error(r.stderr || 'No se pudo extraer el archivo');
}

// Descarga llama.cpp a ~/.codice/bin/llama.cpp/<variante>.
export async function installEngine({ onProgress } = {}) {
  const installed = [];
  for (const pkg of enginePackages()) {
    const dir = path.join(engineDir(), pkg.variant);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const archive = path.join(dir, path.basename(pkg.url));
    await download(pkg.url, archive, (d, t) => onProgress?.(pkg.variant, d, t));
    extract(archive, dir);
    fs.rmSync(archive, { force: true });
    const exe = findExe(dir);
    if (exe && process.platform !== 'win32') fs.chmodSync(exe, 0o755);
    if (exe) installed.push({ path: exe, variant: pkg.variant });
  }
  if (!installed.length) throw new Error(L('No se encontró llama-server tras la descarga', 'llama-server not found after download'));
  return installed;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

export class EngineError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// Un solo servidor a la vez: se reutiliza si el modelo es el mismo y se reemplaza al cambiar de modelo.
class LocalEngine {
  constructor() {
    this.proc = null;
    this.model = null;
    this.url = null;
    this.starting = null;
    this.onStatus = null;
  }

  alive() {
    return this.proc && this.proc.exitCode === null && !this.proc.killed;
  }

  async ensure(model, settings = {}) {
    if (this.alive() && this.model === model.file) return this.url;
    if (this.starting && this.startingFor === model.file) return this.starting;
    this.startingFor = model.file;
    this.starting = this.start(model, settings).finally(() => { this.starting = null; });
    return this.starting;
  }

  async start(model, settings) {
    this.stop();
    const engines = findEngines(settings);
    if (!engines.length) throw new EngineError(L('Falta el motor llama.cpp para usar modelos GGUF', 'The llama.cpp engine is missing for GGUF models'), 'NO_ENGINE');
    const logDir = path.join(HOME, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const errors = [];
    for (const eng of engines) {
      const port = await freePort();
      const args = ['-m', model.file, '--host', '127.0.0.1', '--port', String(port), '--jinja', '-c', String(settings.contextWindow || 16384), '--alias', model.id];
      if (eng.variant !== 'cpu') args.push('-ngl', String(settings.local?.gpuLayers ?? 99));
      if (settings.local?.threads) args.push('-t', String(settings.local.threads));
      const log = fs.openSync(path.join(logDir, 'llama-server.log'), 'w');
      this.onStatus?.(L(`Cargando ${model.id}…`, `Loading ${model.id}…`));
      const proc = spawn(eng.path, args, { cwd: path.dirname(eng.path), stdio: ['ignore', log, log], windowsHide: true });
      // no mantiene vivo a Códice: al terminar, el handler de 'exit' apaga el motor
      proc.unref();
      const url = `http://127.0.0.1:${port}`;
      const ok = await waitHealthy(url, proc, 180000);
      if (ok) {
        this.proc = proc;
        this.model = model.file;
        this.url = url;
        this.variant = eng.variant;
        return url;
      }
      try { proc.kill(); } catch { /* ya terminó */ }
      errors.push(`${eng.variant}: ${tailLog(path.join(logDir, 'llama-server.log'))}`);
    }
    throw new EngineError(L(`No se pudo cargar el modelo. ${errors.join(' | ')}`, `Could not load the model. ${errors.join(' | ')}`), 'LOAD_FAILED');
  }

  stop() {
    if (this.proc && this.proc.exitCode === null) {
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], { windowsHide: true });
        else this.proc.kill('SIGTERM');
      } catch { /* ya terminó */ }
    }
    this.proc = null;
    this.model = null;
    this.url = null;
  }
}

function tailLog(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
    return (lines.reverse().find((l) => /error|failed|unable|out of memory/i.test(l)) || lines[0] || '').slice(0, 200);
  } catch { return ''; }
}

async function waitHealthy(url, proc, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (proc.exitCode !== null) return false;
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* aún arrancando */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

export const localEngine = new LocalEngine();

// Al salir de Códice se apaga el motor.
process.on('exit', () => localEngine.stop());
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { localEngine.stop(); process.exit(130); });
