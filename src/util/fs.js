// Utilidades de archivos y texto.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv', '.next', '.nuxt', '.cache', '.turbo',
]);

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function resolvePath(p, cwd) {
  const e = expandHome(String(p ?? ''));
  return path.isAbsolute(e) ? path.normalize(e) : path.resolve(cwd, e);
}

export function toPosix(p) {
  return p.split(path.sep).join('/');
}

export function relPath(p, cwd) {
  const r = path.relative(cwd, p);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? toPosix(r) : p;
}

export function readJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

export function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

export function isBinaryBuffer(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function truncateMiddle(s, max = 30000) {
  s = String(s ?? '');
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n\n… [${s.length - max} caracteres omitidos] …\n\n${s.slice(-half)}`;
}

export function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

export function listFiles(dir, ext) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && (!ext || d.name.endsWith(ext)))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// Recorre un árbol de archivos (rutas relativas con "/"), sin entrar a carpetas ignoradas.
export function* walk(root, { maxFiles = 100000 } = {}) {
  const stack = [''];
  let n = 0;
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) stack.push(r);
      } else if (e.isFile()) {
        yield r;
        if (++n >= maxFiles) return;
      }
    }
  }
}

export function findUp(start, names) {
  let dir = path.resolve(start);
  for (;;) {
    for (const n of names) if (fs.existsSync(path.join(dir, n))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function setDeep(obj, keyPath, value) {
  const keys = keyPath.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof o[keys[i]] !== 'object' || o[keys[i]] === null) o[keys[i]] = {};
    o = o[keys[i]];
  }
  if (value === undefined) delete o[keys.at(-1)];
  else o[keys.at(-1)] = value;
  return obj;
}

export function getDeep(obj, keyPath) {
  return keyPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function randomId(len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 3.6);
}

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

export function formatTokens(n) {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}
