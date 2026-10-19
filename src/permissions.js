// Permisos: modos, reglas allow/deny estilo "Bash(npm test:*)" y diálogo de aprobación.
import { wildcardMatch } from './util/glob.js';
import { saveSetting } from './config.js';
import { L } from './i18n.js';
import { sandboxStatus } from './sandbox.js';

export const MODES = ['default', 'acceptEdits', 'plan', 'bypass'];

const MODE_TEXT = {
  default: { es: ['⏵⏵ modo: default', 'pide permiso para editar y ejecutar'], en: ['⏵⏵ mode: default', 'asks before editing and running'], color: 'text/muted' },
  acceptEdits: { es: ['⏵⏵ aceptar ediciones', 'edita sin preguntar, pide permiso para comandos'], en: ['⏵⏵ accept edits', 'edits freely, asks before commands'], color: 'status/warning' },
  plan: { es: ['‖ modo plan · solo lectura', 'no edita ni ejecuta'], en: ['‖ plan mode · read only', 'no edits, no commands'], color: 'status/agent' },
  bypass: { es: ['⏵⏵ sin permisos', 'todo permitido, úsalo con cuidado'], en: ['⏵⏵ bypass permissions', 'everything allowed, use with care'], color: 'status/error' },
};

// Etiquetas en el idioma actual (se evalúan al leerlas).
export const MODE_INFO = new Proxy({}, {
  get(_, mode) {
    const m = MODE_TEXT[mode];
    if (!m) return undefined;
    const [label, hint] = L(m.es, m.en);
    return { label, hint, color: m.color };
  },
});

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
    if (deny.some((r) => matchRule(r, tool.name, key))) return { allowed: false, reason: L(`Bloqueado por una regla deny de la configuración (${tool.name}).`, `Blocked by a deny rule in settings (${tool.name}).`) };
    if (this.runtime.offline && tool.network) return { allowed: false, reason: L('Modo offline activo: las herramientas de red están desactivadas.', 'Offline mode: network tools are disabled.') };
    if (mode === 'plan' && !tool.readOnly) return { allowed: false, reason: L('Modo plan activo: solo herramientas de lectura. Termina el plan y preséntalo con ExitPlanMode.', 'Plan mode is active: read-only tools only. Finish the plan and present it with ExitPlanMode.') };
    if (tool.readOnly) return { allowed: true };
    if (allow.some((r) => matchRule(r, tool.name, key))) return { allowed: true };
    if (mode === 'bypass') return { allowed: true };
    // dentro del sandbox el comando no puede dañar el equipo: no hace falta preguntar
    if (tool.sandboxable) {
      const st = sandboxStatus(this.runtime.settings);
      if (st.active && st.autoAllow) return { allowed: true, sandboxed: true };
    }
    if (mode === 'acceptEdits' && tool.edits) return { allowed: true };
    const ui = ctx.ui;
    if (!ui?.interactive) return { allowed: false, reason: L(`Se necesita permiso para ${tool.name}. Ejecuta con --yolo o añade "${suggestRule(tool, key)}" a permissions.allow.`, `Permission needed for ${tool.name}. Run with --yolo or add "${suggestRule(tool, key)}" to permissions.allow.`) };
    // un diálogo a la vez (subagentes en paralelo)
    const run = this.queue.then(() => this.ask(tool, args, key, ctx));
    this.queue = run.catch(() => {});
    return run;
  }

  async ask(tool, args, key, ctx) {
    if (ctx.signal?.aborted) return { allowed: false, reason: L('Interrumpido', 'Interrupted') };
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
    // "no preguntar más en esta sesión": pasa a modo sin permisos solo en memoria (no se guarda; al reabrir vuelve
    // a default). Útil para tareas largas con muchos comandos; el usuario aceptó el riesgo.
    if (answer?.choice === 'session') {
      this.runtime.setPermissionMode('bypass');
      return { allowed: true };
    }
    return { allowed: false, reason: answer?.feedback ? `The user rejected this action and said: ${answer.feedback}` : 'The user rejected this action. Ask what they would prefer.', userDenied: true };
  }
}

function readLocalAllow(runtime) {
  return runtime.localSettings?.permissions?.allow || [];
}
