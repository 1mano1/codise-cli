// Bash: ejecuta comandos de shell (Git Bash o PowerShell en Windows, $SHELL en Unix).
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { truncateMiddle } from '../util/fs.js';
import { L } from '../i18n.js';

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

export function runShell(command, { cwd, timeout = 120000, signal, shell, env } = {}) {
  return new Promise((resolve) => {
    const sh = shell || detectShell();
    const child = spawn(sh, argsFor(sh, command), {
      cwd,
      env: { ...process.env, CODICE: '1', ...env },
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
  async run(a, ctx) {
    const timeout = Math.min(Number(a.timeout) || 120000, 600000);
    const r = await runShell(String(a.command), { cwd: ctx.cwd, timeout, signal: ctx.signal, shell: detectShell(ctx.runtime.settings) });
    if (r.killed === 'abort') throw Object.assign(new Error(L('Interrumpido por el usuario', 'Interrupted by the user')), { name: 'AbortError' });
    let out = truncateMiddle(r.output.replace(/\r\n/g, '\n').trimEnd(), 30000);
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
