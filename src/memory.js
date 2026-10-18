// Memoria del proyecto: CODICE.md y, por compatibilidad, los archivos de contexto de otros agentes
// (Claude Code, Codex/OpenCode, Gemini CLI, Qwen Code, Copilot, Cursor, Windsurf, Cline, Aider).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HOME } from './config.js';

// Archivos de contexto conocidos, relativos a cada carpeta del proyecto.
export const PROJECT_MEMORY = [
  { rel: 'CODICE.md', agent: 'Códice' },
  { rel: '.codice/CODICE.md', agent: 'Códice' },
  { rel: 'CLAUDE.md', agent: 'Claude Code', compat: true },
  { rel: '.claude/CLAUDE.md', agent: 'Claude Code', compat: true },
  { rel: 'AGENTS.md', agent: 'Codex / OpenCode', compat: true },
  { rel: 'GEMINI.md', agent: 'Gemini CLI', compat: true },
  { rel: 'QWEN.md', agent: 'Qwen Code', compat: true },
  { rel: '.github/copilot-instructions.md', agent: 'GitHub Copilot', compat: true },
  { rel: '.cursorrules', agent: 'Cursor', compat: true },
  { rel: '.cursor/rules', agent: 'Cursor', compat: true, dir: true },
  { rel: '.windsurfrules', agent: 'Windsurf', compat: true },
  { rel: '.clinerules', agent: 'Cline', compat: true, dirOrFile: true },
  { rel: 'CONVENTIONS.md', agent: 'Aider', compat: true },
];

function userMemory() {
  const h = os.homedir();
  return [
    { file: path.join(HOME, 'CODICE.md'), agent: 'Códice' },
    { file: path.join(h, '.claude', 'CLAUDE.md'), agent: 'Claude Code', compat: true },
    { file: path.join(h, '.codex', 'AGENTS.md'), agent: 'Codex', compat: true },
    { file: path.join(h, '.gemini', 'GEMINI.md'), agent: 'Gemini CLI', compat: true },
    { file: path.join(h, '.qwen', 'QWEN.md'), agent: 'Qwen Code', compat: true },
  ];
}

// Carpetas desde la raíz del proyecto hasta el directorio actual.
function projectDirs(cwd, projectRoot) {
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
  return dirs;
}

function rulesIn(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /\.(md|mdc|txt)$/i.test(f)).sort().map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export function memoryFiles(cwd, projectRoot, { compat = true } = {}) {
  const candidates = userMemory().filter((m) => compat || !m.compat).map((m) => ({ ...m, scope: 'usuario' }));
  for (const dir of projectDirs(cwd, projectRoot)) {
    for (const m of PROJECT_MEMORY) {
      if (m.compat && !compat) continue;
      const p = path.join(dir, m.rel);
      let isDir = false;
      try { isDir = fs.statSync(p).isDirectory(); } catch { continue; }
      if (isDir && (m.dir || m.dirOrFile)) for (const f of rulesIn(p)) candidates.push({ file: f, agent: m.agent, compat: m.compat, scope: 'proyecto' });
      else if (!isDir && !m.dir) candidates.push({ file: p, agent: m.agent, compat: m.compat, scope: 'proyecto' });
    }
  }
  const seen = new Set();
  return candidates.filter((c) => {
    const k = path.resolve(c.file).toLowerCase();
    if (seen.has(k) || !fs.existsSync(c.file)) return false;
    seen.add(k);
    return true;
  });
}

export function loadMemory(cwd, projectRoot, opts) {
  return memoryFiles(cwd, projectRoot, opts).map((m) => {
    let content = '';
    try { content = fs.readFileSync(m.file, 'utf8'); } catch { /* ilegible */ }
    // reglas de Cursor (.mdc) traen frontmatter: no aporta al modelo
    content = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    if (content.length > 40000) content = `${content.slice(0, 40000)}\n…(recortado)`;
    return { ...m, name: path.relative(projectRoot, m.file).startsWith('..') ? path.basename(m.file) : path.relative(projectRoot, m.file).replace(/\\/g, '/'), content };
  });
}

export function projectMemoryFile(projectRoot) {
  return path.join(projectRoot, 'CODICE.md');
}

export function addMemory(projectRoot, text, scope = 'proyecto') {
  const file = scope === 'usuario' ? path.join(HOME, 'CODICE.md') : projectMemoryFile(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prefix = fs.existsSync(file) ? (fs.readFileSync(file, 'utf8').endsWith('\n') ? '' : '\n') : '# Memoria del proyecto\n\n';
  fs.appendFileSync(file, `${prefix}- ${text.trim()}\n`);
  return file;
}
