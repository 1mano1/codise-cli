// Memoria entre sesiones: registro automático de lo que se hizo en cada mensaje (sin usar el modelo).
// Se guarda por proyecto en ~/.codice/projects/<id>/activity.jsonl y se resume al iniciar una sesión nueva.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME } from './config.js';

const MAX_ENTRIES = 200;

function projectDir(projectRoot) {
  const id = crypto.createHash('sha1').update(path.resolve(projectRoot).toLowerCase()).digest('hex').slice(0, 12);
  return path.join(HOME, 'projects', `${path.basename(projectRoot).replace(/[^\w.-]/g, '_')}-${id}`);
}

export function activityFile(projectRoot) {
  return path.join(projectDir(projectRoot), 'activity.jsonl');
}

export function logActivity(projectRoot, entry) {
  const file = activityFile(projectRoot);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ time: Date.now(), ...entry })}\n`);
    // recorte ocasional para que no crezca sin límite
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    if (lines.length > MAX_ENTRIES * 1.5) fs.writeFileSync(file, `${lines.slice(-MAX_ENTRIES).join('\n')}\n`);
  } catch { /* sin disco: la memoria es opcional */ }
}

export function readActivity(projectRoot, { limit = 12, excludeSession = null } = {}) {
  try {
    return fs.readFileSync(activityFile(projectRoot), 'utf8').trim().split('\n')
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && e.session !== excludeSession)
      .slice(-limit);
  } catch {
    return [];
  }
}

export function clearActivity(projectRoot) {
  try { fs.rmSync(activityFile(projectRoot), { force: true }); } catch { /* nada que borrar */ }
}

// Texto compacto para el modelo (inglés: los modelos lo siguen mejor).
export function formatActivity(entries) {
  return entries.map((e) => {
    const date = new Date(e.time).toISOString().slice(0, 16).replace('T', ' ');
    const parts = [`- ${date} — request: "${e.prompt}"`];
    if (e.files?.length) parts.push(`files changed: ${e.files.join(', ')}`);
    if (e.tools && Object.keys(e.tools).length) parts.push(`tools: ${Object.entries(e.tools).map(([k, v]) => `${k}×${v}`).join(', ')}`);
    if (e.outcome) parts.push(`result: ${e.outcome}`);
    if (e.error) parts.push(`error: ${e.error}`);
    return parts.join(' · ');
  }).join('\n');
}

// Resume un turno a partir de los mensajes nuevos.
export function summarizeTurn({ prompt, messages, files, error, session, model, cwd }) {
  const tools = {};
  let outcome = '';
  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const tc of m.tool_calls || []) tools[tc.function.name] = (tools[tc.function.name] || 0) + 1;
      if (m.content?.trim()) outcome = m.content.trim();
    }
  }
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  return {
    session,
    model,
    prompt: clip(String(prompt).replace(/\s+/g, ' ').trim(), 160),
    files: (files || []).map((f) => path.relative(cwd, f).replace(/\\/g, '/') || f).slice(0, 12),
    tools,
    outcome: clip(outcome.replace(/\s+/g, ' '), 200),
    error: error ? clip(String(error), 160) : undefined,
  };
}
