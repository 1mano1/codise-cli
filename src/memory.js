// Memoria del proyecto: CODICE.md (usuario y proyecto) y, por compatibilidad, CLAUDE.md y AGENTS.md.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HOME } from './config.js';

export function memoryFiles(cwd, projectRoot, { compat = true } = {}) {
  const candidates = [
    { file: path.join(HOME, 'CODICE.md'), scope: 'usuario' },
  ];
  if (compat) candidates.push({ file: path.join(os.homedir(), '.claude', 'CLAUDE.md'), scope: 'usuario' });
  // desde la raíz del proyecto hasta el directorio actual
  const dirs = [];
  let d = path.resolve(cwd);
  const root = path.resolve(projectRoot);
  for (;;) {
    dirs.unshift(d);
    if (d === root) break;
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  for (const dir of dirs) {
    candidates.push({ file: path.join(dir, 'CODICE.md'), scope: 'proyecto' });
    candidates.push({ file: path.join(dir, '.codice', 'CODICE.md'), scope: 'proyecto' });
    if (compat) {
      candidates.push({ file: path.join(dir, 'CLAUDE.md'), scope: 'proyecto' });
      candidates.push({ file: path.join(dir, 'AGENTS.md'), scope: 'proyecto' });
    }
  }
  const seen = new Set();
  return candidates.filter((c) => {
    const k = c.file.toLowerCase();
    if (seen.has(k) || !fs.existsSync(c.file)) return false;
    seen.add(k);
    return true;
  });
}

export function loadMemory(cwd, projectRoot, opts) {
  return memoryFiles(cwd, projectRoot, opts).map((m) => {
    let content = '';
    try { content = fs.readFileSync(m.file, 'utf8'); } catch { /* ilegible */ }
    if (content.length > 40000) content = `${content.slice(0, 40000)}\n…(recortado)`;
    return { ...m, name: path.basename(m.file), content };
  });
}

export function addMemory(projectRoot, text, scope = 'proyecto') {
  const file = scope === 'usuario' ? path.join(HOME, 'CODICE.md') : path.join(projectRoot, 'CODICE.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prefix = fs.existsSync(file) ? (fs.readFileSync(file, 'utf8').endsWith('\n') ? '' : '\n') : '# Memoria del proyecto\n\n';
  fs.appendFileSync(file, `${prefix}- ${text.trim()}\n`);
  return file;
}
