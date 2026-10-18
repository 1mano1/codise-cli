// Herramientas de archivos: Read, Write, Edit, LS.
import fs from 'node:fs';
import path from 'node:path';
import { resolvePath, relPath, isBinaryBuffer } from '../util/fs.js';
import { diffStats } from '../ui/output.js';

const MAX_LINE = 2000;

export const Read = {
  name: 'Read',
  readOnly: true,
  description: 'Read a text file. Returns lines prefixed with their line number (cat -n format). Use offset/limit for large files. Always read a file before editing it.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file (absolute or relative to the working directory)' },
      offset: { type: 'number', description: 'First line to read (1-based)' },
      limit: { type: 'number', description: 'Maximum number of lines (default 2000)' },
    },
    required: ['file_path'],
  },
  summary: (a, ctx) => relPath(resolvePath(a.file_path, ctx.cwd), ctx.cwd),
  permissionKey: (a, ctx) => resolvePath(a.file_path, ctx.cwd),
  async run(a, ctx) {
    const p = resolvePath(a.file_path, ctx.cwd);
    if (!fs.existsSync(p)) throw new Error(`No existe el archivo: ${p}`);
    const st = fs.statSync(p);
    if (st.isDirectory()) throw new Error(`${p} es una carpeta; usa LS o Glob`);
    const buf = fs.readFileSync(p);
    if (isBinaryBuffer(buf)) return { content: `[Archivo binario de ${st.size} bytes]`, display: 'Archivo binario' };
    const lines = buf.toString('utf8').replace(/^﻿/, '').split(/\r?\n/);
    const start = Math.max(1, Number(a.offset) || 1);
    const limit = Math.max(1, Number(a.limit) || 2000);
    const slice = lines.slice(start - 1, start - 1 + limit);
    ctx.runtime.readFiles.add(p);
    let content = slice.map((l, i) => `${String(start + i).padStart(6)}\t${l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}…` : l}`).join('\n');
    const rest = lines.length - (start - 1 + slice.length);
    if (rest > 0) content += `\n… (${rest} líneas más; usa offset=${start + slice.length} para continuar)`;
    if (!slice.length) content = '(archivo vacío o fuera de rango)';
    return { content, display: `Leídas ${slice.length} líneas` };
  },
};

export const Write = {
  name: 'Write',
  edits: true,
  description: 'Create a new file or completely overwrite an existing one. Prefer Edit for changes to existing files. Read the file first if it exists.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path of the file to write' },
      content: { type: 'string', description: 'Full content of the file' },
    },
    required: ['file_path', 'content'],
  },
  summary: (a, ctx) => relPath(resolvePath(a.file_path, ctx.cwd), ctx.cwd),
  permissionKey: (a, ctx) => resolvePath(a.file_path, ctx.cwd),
  preview(a, ctx) {
    const p = resolvePath(a.file_path, ctx.cwd);
    const old = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    return { kind: 'diff', old, new: String(a.content ?? ''), file: relPath(p, ctx.cwd), created: !fs.existsSync(p) };
  },
  async run(a, ctx) {
    const p = resolvePath(a.file_path, ctx.cwd);
    const exists = fs.existsSync(p);
    if (exists && fs.statSync(p).isDirectory()) throw new Error(`${p} es una carpeta`);
    const old = exists ? fs.readFileSync(p, 'utf8') : '';
    ctx.runtime.checkpoints?.snapshot(p);
    let content = String(a.content ?? '');
    if (exists && old.includes('\r\n') && !content.includes('\r\n')) content = content.replace(/\n/g, '\r\n');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    ctx.runtime.readFiles.add(p);
    const lines = content.split('\n').length;
    if (!exists) {
      ctx.ui?.diff('', content.replace(/\r\n/g, '\n'), 1, { maxLines: 12 });
      return { content: `Archivo creado: ${p} (${lines} líneas)`, display: `Creado · ${lines} líneas` };
    }
    const st = diffStats(old.replace(/\r\n/g, '\n'), content.replace(/\r\n/g, '\n'));
    ctx.ui?.diff(old.replace(/\r\n/g, '\n'), content.replace(/\r\n/g, '\n'), 1);
    return { content: `Archivo sobrescrito: ${p} (${lines} líneas)`, display: `Reescrito · +${st.added} −${st.removed}` };
  },
};

// Busca old en content; si no está exacto, intenta ignorando espacios al final de línea.
function locate(content, oldStr) {
  const idx = content.indexOf(oldStr);
  if (idx >= 0) {
    const count = content.split(oldStr).length - 1;
    return { index: idx, length: oldStr.length, count, exact: true };
  }
  const lines = content.split('\n');
  const target = oldStr.split('\n').map((l) => l.trimEnd());
  const hits = [];
  for (let i = 0; i + target.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < target.length; j++) if (lines[i + j].trimEnd() !== target[j]) { ok = false; break; }
    if (ok) hits.push(i);
  }
  if (!hits.length) return null;
  const start = lines.slice(0, hits[0]).join('\n').length + (hits[0] ? 1 : 0);
  const len = lines.slice(hits[0], hits[0] + target.length).join('\n').length;
  return { index: start, length: len, count: hits.length, exact: false };
}

export const Edit = {
  name: 'Edit',
  edits: true,
  description: 'Replace an exact string in a file. old_string must match the file exactly (including indentation) and be unique unless replace_all is true. Read the file before editing.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path of the file to edit' },
      old_string: { type: 'string', description: 'Exact text to replace' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  summary: (a, ctx) => relPath(resolvePath(a.file_path, ctx.cwd), ctx.cwd),
  permissionKey: (a, ctx) => resolvePath(a.file_path, ctx.cwd),
  prepare(a, ctx) {
    const p = resolvePath(a.file_path, ctx.cwd);
    if (!fs.existsSync(p)) throw new Error(`No existe el archivo: ${p}. Usa Write para crearlo.`);
    const raw = fs.readFileSync(p, 'utf8');
    const crlf = raw.includes('\r\n');
    const content = raw.replace(/\r\n/g, '\n');
    const oldStr = String(a.old_string ?? '').replace(/\r\n/g, '\n');
    const newStr = String(a.new_string ?? '').replace(/\r\n/g, '\n');
    if (!oldStr) throw new Error('old_string está vacío. Para crear un archivo usa Write.');
    if (oldStr === newStr) throw new Error('old_string y new_string son iguales; no hay nada que cambiar.');
    const loc = locate(content, oldStr);
    if (!loc) throw new Error('No encontré old_string en el archivo. Vuelve a leerlo con Read y copia el texto exacto, con su indentación.');
    if (loc.count > 1 && !a.replace_all) throw new Error(`old_string aparece ${loc.count} veces. Añade más contexto para que sea único o usa replace_all: true.`);
    let updated;
    if (a.replace_all && loc.exact) updated = content.split(oldStr).join(newStr);
    else updated = content.slice(0, loc.index) + newStr + content.slice(loc.index + loc.length);
    const startLine = content.slice(0, loc.index).split('\n').length;
    return { p, content, updated, crlf, startLine, count: a.replace_all ? loc.count : 1 };
  },
  preview(a, ctx) {
    const r = this.prepare(a, ctx);
    return { kind: 'diff', old: r.content, new: r.updated, file: relPath(r.p, ctx.cwd), startLine: 1 };
  },
  async run(a, ctx) {
    const r = this.prepare(a, ctx);
    if (!ctx.runtime.readFiles.has(r.p)) throw new Error('Lee el archivo con Read antes de editarlo.');
    ctx.runtime.checkpoints?.snapshot(r.p);
    fs.writeFileSync(r.p, r.crlf ? r.updated.replace(/\n/g, '\r\n') : r.updated);
    const st = diffStats(r.content, r.updated);
    ctx.ui?.diff(r.content, r.updated, 1);
    return {
      content: `Archivo editado: ${r.p} (${r.count} reemplazo${r.count > 1 ? 's' : ''}, desde la línea ${r.startLine})`,
      display: `${r.count} cambio${r.count > 1 ? 's' : ''} · +${st.added} −${st.removed}`,
    };
  },
};

export const LS = {
  name: 'LS',
  readOnly: true,
  description: 'List the files and folders of a directory (non-recursive).',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory (default: working directory)' } },
  },
  summary: (a, ctx) => relPath(resolvePath(a.path || '.', ctx.cwd), ctx.cwd) || '.',
  permissionKey: (a, ctx) => resolvePath(a.path || '.', ctx.cwd),
  async run(a, ctx) {
    const p = resolvePath(a.path || '.', ctx.cwd);
    const entries = fs.readdirSync(p, { withFileTypes: true })
      .sort((x, y) => (y.isDirectory() - x.isDirectory()) || x.name.localeCompare(y.name));
    const lines = entries.slice(0, 500).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    if (entries.length > 500) lines.push(`… (${entries.length - 500} más)`);
    return { content: lines.join('\n') || '(carpeta vacía)', display: `${entries.length} elementos` };
  },
};
