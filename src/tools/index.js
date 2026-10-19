// Registro de herramientas integradas.
import { Read, Write, Edit, LS } from './files.js';
import { Glob, Grep } from './search.js';
import { Bash } from './bash.js';
import { WebFetch, WebSearch } from './web.js';
import { TodoWrite, Task, Skill, AskUser, ExitPlanMode, Remember } from './meta.js';

export const BUILTIN_TOOLS = [Read, Write, Edit, LS, Glob, Grep, Bash, WebFetch, WebSearch, TodoWrite, Task, Skill, Remember, AskUser, ExitPlanMode];

// Descripción para el modelo (algunas herramientas la generan según el estado).
// lean (modelos pequeños/locales): descripción de una sola frase y parámetros sin textos de ayuda.
export function toolSpec(tool, runtime, { lean = false } = {}) {
  let description = tool.describe ? tool.describe(runtime) : tool.description;
  if (!lean) return { name: tool.name, description, parameters: tool.parameters };
  const [first, ...rest] = description.split('\n\n');
  description = first.split(/(?<=\.)\s/)[0];
  // la lista de agentes o skills disponibles se conserva: el modelo la necesita para elegir
  const list = rest.find((p) => /^Available (agents|skills)/.test(p));
  if (list) description += `\n\n${list.split('\n').map((l) => (l.length > 70 ? `${l.slice(0, 67).replace(/\s+\S*$/, '')}…` : l)).join('\n')}`;
  return { name: tool.name, description, parameters: stripDescriptions(tool.parameters) };
}

function stripDescriptions(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(stripDescriptions);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'description' && typeof v === 'string') continue;
    out[k] = typeof v === 'object' ? stripDescriptions(v) : v;
  }
  return out;
}

// Valida argumentos requeridos y tipos básicos contra el JSON Schema.
export function validateArgs(tool, args) {
  const schema = tool.parameters || {};
  for (const req of schema.required || []) {
    if (args[req] === undefined || args[req] === null || args[req] === '') return `Falta el parámetro obligatorio "${req}"`;
  }
  for (const [k, v] of Object.entries(args)) {
    const p = schema.properties?.[k];
    if (!p || v == null) continue;
    if (p.type === 'string' && typeof v !== 'string') args[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (p.type === 'number' && typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) args[k] = Number(v);
    if (p.type === 'boolean' && typeof v === 'string') args[k] = v === 'true';
    if (p.type === 'array' && typeof v === 'string') {
      try { args[k] = JSON.parse(v); } catch { return `El parámetro "${k}" debe ser una lista`; }
    }
  }
  return null;
}

export function parseToolArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  const s = String(raw ?? '').trim();
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    const fixed = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(fixed);
  }
}
