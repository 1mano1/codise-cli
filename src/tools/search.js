// Búsqueda: Glob (nombres de archivo) y Grep (contenido).
import fs from 'node:fs';
import path from 'node:path';
import { resolvePath, relPath, walk, isBinaryBuffer, toPosix } from '../util/fs.js';
import { globToRegex, makeMatcher } from '../util/glob.js';
import { L } from '../i18n.js';

export const Glob = {
  name: 'Glob',
  readOnly: true,
  description: 'Find files by glob pattern (e.g. "**/*.ts", "src/**/*.{js,jsx}"). Returns paths sorted by modification time (newest first). Ignores node_modules and .git.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern' },
      path: { type: 'string', description: 'Base directory (default: working directory)' },
    },
    required: ['pattern'],
  },
  summary: (a) => `"${a.pattern}"${a.path ? `, ${a.path}` : ''}`,
  permissionKey: (a, ctx) => resolvePath(a.path || '.', ctx.cwd),
  async run(a, ctx) {
    const base = resolvePath(a.path || '.', ctx.cwd);
    const pattern = toPosix(String(a.pattern || '**/*')).replace(/^\.\//, '');
    const re = globToRegex(pattern);
    const matches = [];
    for (const rel of walk(base)) {
      if (ctx.signal?.aborted) break;
      if (re.test(rel)) {
        let mtime = 0;
        try { mtime = fs.statSync(path.join(base, rel)).mtimeMs; } catch { /* ignorar */ }
        matches.push({ rel, mtime });
      }
    }
    matches.sort((x, y) => y.mtime - x.mtime);
    const shown = matches.slice(0, 200).map((m) => relPath(path.join(base, m.rel), ctx.cwd));
    let content = shown.join('\n') || 'No matches';
    if (matches.length > 200) content += `\n… (${matches.length - 200} more; refine the pattern)`;
    return { content, display: L(`${matches.length} archivo${matches.length === 1 ? '' : 's'}`, `${matches.length} file${matches.length === 1 ? '' : 's'}`) };
  },
};

export const Grep = {
  name: 'Grep',
  readOnly: true,
  description: 'Search file contents with a regular expression (JavaScript syntax). output_mode: "files_with_matches" (default), "content" (matching lines with numbers) or "count".',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression' },
      path: { type: 'string', description: 'File or directory (default: working directory)' },
      glob: { type: 'string', description: 'Filter files by glob, e.g. "*.js"' },
      output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'] },
      ignore_case: { type: 'boolean' },
      context: { type: 'number', description: 'Lines of context around matches (content mode)' },
      head_limit: { type: 'number', description: 'Maximum results (default 200)' },
    },
    required: ['pattern'],
  },
  summary: (a) => `"${a.pattern}"${a.glob ? `, ${a.glob}` : ''}${a.path ? `, ${a.path}` : ''}`,
  permissionKey: (a, ctx) => resolvePath(a.path || '.', ctx.cwd),
  async run(a, ctx) {
    let re;
    try {
      re = new RegExp(a.pattern, a.ignore_case ? 'i' : '');
    } catch (e) {
      throw new Error(L(`Expresión regular inválida: ${e.message}`, `Invalid regular expression: ${e.message}`));
    }
    const target = resolvePath(a.path || '.', ctx.cwd);
    const mode = a.output_mode || 'files_with_matches';
    const limit = Number(a.head_limit) || 200;
    const ctxLines = Math.min(Number(a.context) || 0, 10);
    const match = makeMatcher(a.glob);
    const files = fs.existsSync(target) && fs.statSync(target).isFile()
      ? [{ abs: target, rel: path.basename(target) }]
      : [...walk(target)].filter(match).map((rel) => ({ abs: path.join(target, rel), rel }));
    const results = [];
    let total = 0;
    for (const f of files) {
      if (ctx.signal?.aborted || results.length >= limit) break;
      let buf;
      try {
        const st = fs.statSync(f.abs);
        if (st.size > 2_000_000) continue;
        buf = fs.readFileSync(f.abs);
      } catch { continue; }
      if (isBinaryBuffer(buf)) continue;
      const lines = buf.toString('utf8').split(/\r?\n/);
      const hits = [];
      lines.forEach((l, i) => { if (re.test(l)) hits.push(i); });
      if (!hits.length) continue;
      total += hits.length;
      const shown = relPath(f.abs, ctx.cwd);
      if (mode === 'files_with_matches') results.push(shown);
      else if (mode === 'count') results.push(`${shown}: ${hits.length}`);
      else {
        const keep = new Set();
        for (const h of hits) for (let k = Math.max(0, h - ctxLines); k <= Math.min(lines.length - 1, h + ctxLines); k++) keep.add(k);
        for (const k of [...keep].sort((x, y) => x - y)) {
          if (results.length >= limit) break;
          const l = lines[k].length > 400 ? `${lines[k].slice(0, 400)}…` : lines[k];
          results.push(`${shown}:${k + 1}${hits.includes(k) ? ':' : '-'}${l}`);
        }
      }
    }
    const content = results.join('\n') || 'No matches';
    const display = mode === 'files_with_matches' ? L(`${results.length} archivo${results.length === 1 ? '' : 's'}`, `${results.length} file${results.length === 1 ? '' : 's'}`) : L(`${total} coincidencia${total === 1 ? '' : 's'}`, `${total} match${total === 1 ? '' : 'es'}`);
    return { content: results.length >= limit ? `${content}\n… (limit of ${limit} results)` : content, display };
  },
};
