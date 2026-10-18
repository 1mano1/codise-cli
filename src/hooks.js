// Hooks: comandos que se ejecutan en eventos (PreToolUse, PostToolUse, UserPromptSubmit, Stop, SessionStart,
// SubagentStop). Reciben JSON por stdin. Código de salida 2 = bloquear (stderr se pasa al modelo).
import { spawn } from 'node:child_process';

export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SubagentStop'];

function execHook(command, payload, { cwd, timeout = 60000, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, ...env }, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill(), timeout);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: 1, stdout, stderr: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

function matches(matcher, target) {
  if (!matcher || matcher === '*' || target == null) return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(target);
  } catch {
    return matcher === target;
  }
}

// hooks: { Evento: [{ matcher, hooks: [{ type: "command", command, timeout }] , pluginRoot? }] }
export async function runHooks(hooksConfig, event, payload, { target = null, cwd, sessionId, projectDir } = {}) {
  const groups = hooksConfig?.[event] || [];
  const result = { blocked: false, reason: '', context: '' };
  const reasons = [], context = [];
  for (const g of groups) {
    if (!matches(g.matcher, target)) continue;
    for (const h of g.hooks || []) {
      if (h.type && h.type !== 'command') continue;
      let command = h.command;
      if (g.pluginRoot) command = command.replace(/\$\{(CODICE|CLAUDE)_PLUGIN_ROOT\}/g, g.pluginRoot);
      const r = await execHook(command, { ...payload, hook_event_name: event, session_id: sessionId, cwd }, {
        cwd,
        timeout: (h.timeout || 60) * 1000,
        env: { CODICE_PROJECT_DIR: projectDir || cwd, CLAUDE_PROJECT_DIR: projectDir || cwd, ...(g.pluginRoot ? { CODICE_PLUGIN_ROOT: g.pluginRoot, CLAUDE_PLUGIN_ROOT: g.pluginRoot } : {}) },
      });
      if (r.code === 2) { result.blocked = true; reasons.push(r.stderr.trim() || 'Bloqueado por un hook'); continue; }
      const out = r.stdout.trim();
      if (!out) continue;
      try {
        const j = JSON.parse(out);
        if (j.decision === 'block' || j.continue === false) { result.blocked = true; reasons.push(j.reason || j.stopReason || 'Bloqueado por un hook'); }
        const extra = j.additionalContext || j.hookSpecificOutput?.additionalContext;
        if (extra) context.push(extra);
      } catch {
        if (event === 'UserPromptSubmit' || event === 'SessionStart') context.push(out);
      }
    }
  }
  result.reason = reasons.join('\n');
  result.context = context.join('\n');
  return result;
}
