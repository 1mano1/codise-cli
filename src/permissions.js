// Permisos: modos, reglas allow/deny estilo "Bash(npm test:*)" y diálogo de aprobación.
import { wildcardMatch } from './util/glob.js';
import { saveSetting } from './config.js';

export const MODES = ['default', 'acceptEdits', 'plan', 'bypass'];

export const MODE_INFO = {
  default: { label: '⏵⏵ modo: default', hint: 'pide permiso para editar y ejecutar', color: 'text/muted' },
  acceptEdits: { label: '⏵⏵ aceptar ediciones', hint: 'edita sin preguntar, pide permiso para comandos', color: 'status/warning' },
  plan: { label: '‖ modo plan · solo lectura', hint: 'no edita ni ejecuta', color: 'status/agent' },
  bypass: { label: '⏵⏵ sin permisos', hint: 'todo permitido, úsalo con cuidado', color: 'status/error' },
};

export function matchRule(rule, toolName, key) {
  const m = String(rule).trim().match(/^([^(]+)(?:\((.*)\))?$/s);
  if (!m) return false;
  const [, name, pattern] = m;
  if (!wildcardMatch(name.trim(), toolName)) return false;
  if (pattern === undefined || pattern === '' || pattern === '*') return true;
  if (key == null) return false;
  let p = pattern;
  if (p.endsWith(':*')) p = `${p.slice(0, -2)}*`;
  return wildcardMatch(p, String(key).replace(/\\/g, '/')) || wildcardMatch(p, String(key));
}

export function suggestRule(tool, key) {
  if (tool.name === 'Bash' && key) {
    const words = key.trim().split(/\s+/);
    const second = words[1] && !/^[-./\\~"']/.test(words[1]) && !words[1].includes('=') ? ` ${words[1]}` : '';
    return `Bash(${words[0]}${second}:*)`;
  }
  if (tool.name === 'WebFetch' && key) return `WebFetch(${key})`;
  return tool.name;
}

export class Permissions {
  constructor(runtime) {
    this.runtime = runtime;
    this.sessionAllow = [];
    this.queue = Promise.resolve();
  }

  rules() {
    const p = this.runtime.settings.permissions || {};
    return { allow: [...(p.allow || []), ...this.sessionAllow], deny: p.deny || [] };
  }

  async check(tool, args, ctx) {
    let key = null;
    try { key = tool.permissionKey ? tool.permissionKey(args, ctx) : null; } catch { key = null; }
    const { allow, deny } = this.rules();
    const mode = this.runtime.permissionMode;
    if (deny.some((r) => matchRule(r, tool.name, key))) return { allowed: false, reason: `Bloqueado por una regla deny de la configuración (${tool.name}).` };
    if (this.runtime.offline && tool.network) return { allowed: false, reason: 'Modo offline activo: las herramientas de red están desactivadas.' };
    if (mode === 'plan' && !tool.readOnly) return { allowed: false, reason: 'Modo plan activo: solo herramientas de lectura. Termina el plan y preséntalo con ExitPlanMode.' };
    if (tool.readOnly) return { allowed: true };
    if (allow.some((r) => matchRule(r, tool.name, key))) return { allowed: true };
    if (mode === 'bypass') return { allowed: true };
    if (mode === 'acceptEdits' && tool.edits) return { allowed: true };
    const ui = ctx.ui;
    if (!ui?.interactive) return { allowed: false, reason: `Se necesita permiso para ${tool.name}. Ejecuta con --yolo o añade "${suggestRule(tool, key)}" a permissions.allow.` };
    // un diálogo a la vez (subagentes en paralelo)
    const run = this.queue.then(() => this.ask(tool, args, key, ctx));
    this.queue = run.catch(() => {});
    return run;
  }

  async ask(tool, args, key, ctx) {
    if (ctx.signal?.aborted) return { allowed: false, reason: 'Interrumpido' };
    // revisar de nuevo: otra petición pudo añadir la regla mientras esperaba
    if (this.rules().allow.some((r) => matchRule(r, tool.name, key))) return { allowed: true };
    let preview = null;
    try { preview = tool.preview ? tool.preview(args, ctx) : null; } catch (e) { return { allowed: false, reason: e.message }; }
    const rule = suggestRule(tool, key);
    const answer = await ctx.ui.permission({ tool, args, key, preview, rule, agentLabel: ctx.agentLabel });
    if (answer?.choice === 'yes') return { allowed: true };
    if (answer?.choice === 'always') {
      this.sessionAllow.push(rule);
      try { saveSetting(this.runtime.projectRoot, 'local', 'permissions.allow', [...new Set([...(readLocalAllow(this.runtime)), rule])]); } catch { /* sin disco */ }
      return { allowed: true };
    }
    return { allowed: false, reason: answer?.feedback ? `El usuario rechazó la acción y dijo: ${answer.feedback}` : 'El usuario rechazó la acción. Pregunta qué prefiere hacer.' , userDenied: true };
  }
}

function readLocalAllow(runtime) {
  return runtime.localSettings?.permissions?.allow || [];
}
