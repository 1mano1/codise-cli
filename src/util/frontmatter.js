// Parser mínimo de frontmatter YAML (clave: valor, listas, valores plegados).

function parseValue(v) {
  v = v.trim();
  if (v === '') return '';
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map((s) => parseValue(s)).filter((s) => s !== '');
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

export function parseFrontmatter(text) {
  const m = String(text).match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: String(text) };
  const data = {};
  let last = null;
  let folded = false;
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const item = raw.match(/^\s+-\s+(.*)$/);
    if (item && last) {
      if (!Array.isArray(data[last])) data[last] = [];
      data[last].push(parseValue(item[1]));
      continue;
    }
    const kv = raw.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kv && !/^\s/.test(raw)) {
      last = kv[1];
      const v = kv[2].trim();
      folded = v === '>' || v === '|' || v === '>-' || v === '|-';
      data[last] = folded ? '' : parseValue(v);
    } else if (last && typeof data[last] === 'string') {
      data[last] = (data[last] ? data[last] + (folded ? ' ' : ' ') : '') + raw.trim();
    }
  }
  return { data, body: m[2] };
}

export function stringifyFrontmatter(data, body) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) lines.push(`${k}: ${v.join(', ')}`);
    else lines.push(`${k}: ${String(v).includes(':') ? JSON.stringify(String(v)) : v}`);
  }
  lines.push('---', '');
  return lines.join('\n') + String(body ?? '').trimStart();
}

// Convierte "Read, Grep" o ["Read","Grep"] en lista.
export function toList(v) {
  if (v == null || v === '') return null;
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}
