// Bash: ejecuta comandos de shell (Git Bash o PowerShell en Windows, $SHELL en Unix).
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { truncateMiddle } from '../util/fs.js';
import { L } from '../i18n.js';
import { sandboxStatus, sandboxSpawn, detectBlock } from '../sandbox.js';

let cachedShell = null;

export function detectShell(settings = {}) {
  if (settings.shell) return settings.shell;
  if (cachedShell) return cachedShell;
  if (process.platform !== 'win32') {
    cachedShell = process.env.SHELL || '/bin/bash';
    return cachedShell;
  }
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    `${process.env.LOCALAPPDATA || ''}\\Programs\\Git\\bin\\bash.exe`,
  ];
  cachedShell = candidates.find((c) => fs.existsSync(c));
  if (!cachedShell) {
    const pwsh = spawnSync('where', ['pwsh'], { encoding: 'utf8' });
    cachedShell = pwsh.status === 0 ? 'pwsh' : 'powershell';
  }
  return cachedShell;
}

export function shellLabel(shell) {
  if (/bash/i.test(shell)) return 'bash';
  if (/pwsh|powershell/i.test(shell)) return 'PowerShell';
  if (/cmd/i.test(shell)) return 'cmd';
  return shell;
}

function argsFor(shell, command) {
  if (/pwsh|powershell/i.test(shell)) {
    return ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`];
  }
  if (/cmd(\.exe)?$/i.test(shell)) return ['/d', '/s', '/c', command];
  return ['-c', command];
}

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* terminado */ } }
  }
}

// sandbox: { status, projectRoot, onStatus } para ejecutar el comando encerrado (ver src/sandbox.js).
export async function runShell(command, { cwd, timeout = 120000, signal, shell, env, sandbox = null } = {}) {
  const sh = shell || detectShell();
  let file = sh, args = argsFor(sh, command), extraEnv = {};
  if (sandbox) {
    try {
      const spec = await sandboxSpawn({ status: sandbox.status, command, cwd, projectRoot: sandbox.projectRoot, shell: sh, shellArgs: args, onStatus: sandbox.onStatus });
      ({ file, args } = spec);
      extraEnv = spec.env;
    } catch (e) {
      return { code: -1, output: L(`No se pudo preparar el sandbox: ${e.message}`, `Could not prepare the sandbox: ${e.message}`), killed: null };
    }
  }
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd,
      env: { ...process.env, CODICE: '1', ...env, ...extraEnv },
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let output = '';
    let killed = null;
    const onData = (d) => {
      output += d.toString('utf8');
      if (output.length > 2_000_000) output = output.slice(-1_000_000);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => { killed = 'timeout'; killTree(child); }, timeout);
    const onAbort = () => { killed = 'abort'; killTree(child); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, output: L(`No se pudo ejecutar el shell (${sh}): ${e.message}`, `Could not start the shell (${sh}): ${e.message}`), killed });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code: code ?? -1, output, killed });
    });
  });
}

// La línea más informativa de una salida con error (no "Node.js v22…" ni líneas vacías).
export function errorLine(lines) {
  const useful = lines.map((l) => l.trim()).filter((l) => l && !/^Node\.js v\d/.test(l) && !/^at /.test(l) && l !== '^');
  return [...useful].reverse().find((l) => /(error|exception|failed|fatal|ERR!|not found|no such)/i.test(l)) || useful.at(-1) || '';
}

export const Bash = {
  name: 'Bash',
  description: 'Run a shell command in the working directory and return its output (stdout + stderr). Use for git, package managers, tests, builds. Avoid interactive commands. Prefer Read/Grep/Glob over cat/grep/find.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command to run' },
      description: { type: 'string', description: 'Short description of what the command does (5-10 words)' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 120000, max 600000)' },
    },
    required: ['command'],
  },
  summary: (a) => String(a.command || '').replace(/\s+/g, ' ').slice(0, 120),
  permissionKey: (a) => String(a.command || '').trim(),
  preview: (a) => ({ kind: 'command', command: a.command, description: a.description }),
  sandboxable: true,
  async run(a, ctx) {
    const timeout = Math.min(Number(a.timeout) || 120000, 600000);
    const rt = ctx.runtime;
    const command = String(a.command);
    const base = { cwd: ctx.cwd, timeout, signal: ctx.signal, shell: detectShell(rt.settings) };
    const boxed = (st) => ({ ...base, sandbox: { status: st, projectRoot: rt.projectRoot, onStatus: (m) => rt.spinner?.setVerb?.(m) } });
    let st = sandboxStatus(rt.settings);
    if (st.mode === 'strict' && !st.active) {
      return { content: `The sandbox is required (strict mode) but unavailable: ${st.problem}. Ask the user to fix it or change the mode with /sandbox.`, display: L('sandbox no disponible', 'sandbox unavailable'), isError: true };
    }
    let r = await runShell(command, st.active ? boxed(st) : base);
    let note = '';
    const block = st.active ? detectBlock(r.output, r) : null;
    if (block && r.killed !== 'abort') {
      const what = block.kind === 'network' ? `network access${block.host ? ` to ${block.host}` : ''}` : `writing${block.path ? ` to ${block.path}` : ''} outside the project`;
      if (st.mode === 'auto' && ctx.ui?.interactive && ctx.ui.sandboxBlocked) {
        const ans = await ctx.ui.sandboxBlocked({ command, block, agentLabel: ctx.agentLabel });
        if (ans?.choice === 'allow' && block.host) {
          const domains = [...new Set([...(rt.localSettings?.sandbox?.allowedDomains || []), block.host])];
          rt.save('sandbox.allowedDomains', domains, 'local');
          st = sandboxStatus(rt.settings);
          r = await runShell(command, boxed(st));
          note = `\n[sandbox: the user allowed network access to ${block.host} for this project]`;
        } else if (ans?.choice === 'outside') {
          r = await runShell(command, base);
          note = '\n[ran outside the sandbox once, with the user\'s approval]';
        } else {
          const fb = ans?.feedback ? ` and said: ${ans.feedback}` : '';
          return { content: `${r.output.trimEnd()}\n[sandbox blocked ${what}. The user declined to allow it${fb}]`, display: L('bloqueado por el sandbox', 'blocked by the sandbox'), isError: true, userDenied: true };
        }
      } else {
        note = `\n[sandbox blocked ${what}. Do not try to work around it; tell the user they can allow it with /sandbox]`;
      }
    }
    if (r.killed === 'abort') throw Object.assign(new Error(L('Interrumpido por el usuario', 'Interrupted by the user')), { name: 'AbortError' });
    let out = truncateMiddle(r.output.replace(/\r\n/g, '\n').trimEnd(), 30000) + note;
    if (r.killed === 'timeout') out += `\n[command stopped: exceeded ${timeout} ms]`;
    const lines = out ? out.split('\n') : [];
    const display = r.code === 0
      ? (lines.length ? `${lines.slice(0, 3).join('\n')}${lines.length > 3 ? L(`\n… ${lines.length - 3} líneas más`, `\n… ${lines.length - 3} more lines`) : ''}` : L('Sin salida', 'No output'))
      : `${L('Código de salida', 'Exit code')} ${r.code}${errorLine(lines) ? ` · ${errorLine(lines).slice(0, 120)}` : ''}`;
    return {
      content: `${out || '(no output)'}${r.code !== 0 ? `\n[exit code ${r.code}]` : ''}`,
      display,
      isError: r.code !== 0,
    };
  },
};
