// Bash: ejecuta comandos de shell (Git Bash o PowerShell en Windows, $SHELL en Unix).
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { truncateMiddle } from '../util/fs.js';
import { L } from '../i18n.js';
import { sandboxStatus, sandboxSpawn, detectBlock, hostAllowed } from '../sandbox.js';

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

// ── PATH fresco en Windows ───────────────────────────────────────
// Expande %VARIABLES% de un valor del registro usando el entorno actual.
function expandWinVars(s) {
  return String(s).replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m);
}

function registryPath(root, key) {
  try {
    const r = spawnSync('reg', ['query', `${root}\\${key}`, '/v', 'Path'], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
    if (r.status !== 0) return '';
    const m = r.stdout.match(/\bPath\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
    return m ? expandWinVars(m[1].trim()) : '';
  } catch { return ''; }
}

// Carpetas de instalación comunes que a veces no quedan en el PATH (winget shims, 7-Zip, Git, Node, Python…).
function commonWinDirs() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const la = process.env.LOCALAPPDATA || '';
  const pd = process.env.ProgramData || 'C:\\ProgramData';
  const dirs = [
    la && `${la}\\Microsoft\\WinGet\\Links`, // shims de winget (lo más importante)
    la && `${la}\\Microsoft\\WindowsApps`,
    `${pf}\\7-Zip`, `${pf86}\\7-Zip`,
    `${pf}\\Git\\cmd`, `${pf}\\nodejs`,
    `${pd}\\chocolatey\\bin`,
  ].filter(Boolean);
  // Python suele instalarse con versión en la ruta: se añaden las que existan
  if (la) for (const d of (() => { try { return fs.readdirSync(`${la}\\Programs\\Python`); } catch { return []; } })()) {
    dirs.push(`${la}\\Programs\\Python\\${d}`, `${la}\\Programs\\Python\\${d}\\Scripts`);
  }
  return dirs.filter((d) => { try { return fs.existsSync(d); } catch { return false; } });
}

let pathCache = { at: 0, value: '' };
export function freshWindowsPath() {
  if (Date.now() - pathCache.at < 10000 && pathCache.value) return pathCache.value; // caché de 10 s
  const parts = [];
  const seen = new Set();
  const add = (p) => { for (const d of String(p || '').split(';')) { const t = d.trim(); const k = t.toLowerCase(); if (t && !seen.has(k)) { seen.add(k); parts.push(t); } } };
  add(process.env.PATH); // lo que ya tiene el proceso
  add(registryPath('HKCU', 'Environment')); // PATH de usuario actualizado
  add(registryPath('HKLM', 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')); // PATH del sistema
  for (const d of commonWinDirs()) add(d);
  pathCache = { at: Date.now(), value: parts.join(';') };
  return pathCache.value;
}

// sandbox: { status, projectRoot, onStatus } para ejecutar el comando encerrado (ver src/sandbox.js).
export async function runShell(command, { cwd, timeout = 120000, signal, shell, env, sandbox = null, onProgress = null } = {}) {
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
  // Windows: el PATH de Códice se fijó al arrancar; si el usuario instaló algo durante la sesión (p. ej. 7-Zip),
  // el PATH del registro ya lo incluye pero el proceso no. Se refresca para que esos programas se encuentren.
  const basePath = process.platform === 'win32' && !sandbox ? { PATH: freshWindowsPath() } : {};
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd,
      env: { ...process.env, ...basePath, CODICE: '1', ...env, ...extraEnv },
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let output = '';
    let killed = null;
    const onData = (d) => {
      output += d.toString('utf8');
      if (output.length > 2_000_000) output = output.slice(-1_000_000);
      // avisa en vivo con la última línea útil, para que un comando largo (install/build) no parezca trabado
      if (onProgress) {
        const last = output.replace(/\r/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean).at(-1);
        if (last) onProgress(last);
      }
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

// ¿El comando falló por falta de permisos de administrador en Windows?
export function needsElevation(output) {
  return /admin(?:istrator|istrative)? (?:rights|privileges|access|permissions)|requires? (?:elevation|administrator)|run as administrator|must be run (?:as|with|from an) (?:administrator|elevated)|elevated (?:privileges|permissions|command prompt|powershell)|Access (?:is|to the path).*denied|Access denied|Acceso denegado|permisos? de administrador|se requiere.*administrador|ejec[úu]te?lo como administrador|UnauthorizedAccessException|error 740|The requested operation requires elevation/i.test(String(output || ''));
}

// Comandos de Windows que casi siempre necesitan Administrador (instalar, tocar HKLM, servicios, features…).
export function adminCommand(command) {
  return /\b(choco(?:latey)?)\s+(install|upgrade|uninstall)\b|\bmsiexec\b.*\/(i|x|package)|\bwinget\s+(install|uninstall|upgrade)\b|\breg\s+(add|delete)\s+"?HK(LM|EY_LOCAL_MACHINE)|\bnet\s+(user|localgroup)\b|\bsc(\.exe)?\s+(create|config|delete)\b|\b(dism|bcdedit)\b|Enable-WindowsOptionalFeature|Set-ExecutionPolicy\s+.*LocalMachine|New-Service\b/i.test(String(command || ''));
}

// El comando sin la tubería final a head/tail/Select-Object (para que el usuario pegue el comando real).
export function cleanCommand(command) {
  return String(command).replace(/\s*\|\s*(head|tail|Select-Object|more|findstr|grep|out-file|tee)\b.*$/i, '').trim();
}

// Convierte un comando de la herramienta Bash a algo que el usuario pueda pegar en PowerShell como Administrador.
// (El agente corre en Git Bash; el usuario abre "PowerShell (Administrador)".)
export function elevatedHint(command) {
  const cmd = String(command).trim();
  return L(
    `Este comando necesita permisos de administrador. Ábrelo tú: pulsa Win, escribe "PowerShell", haz clic derecho → "Ejecutar como administrador" y pega:\n  ${cmd}`,
    `This command needs administrator rights. Run it yourself: press Win, type "PowerShell", right-click → "Run as administrator" and paste:\n  ${cmd}`,
  );
}

// ¿El comando falló porque un programa no está instalado? Devuelve el nombre del programa o null.
export function missingProgram(output) {
  const s = String(output || '');
  const m = s.match(/bash: (?:line \d+: )?([\w.+-]+): command not found/i)
    || s.match(/([\w.+-]+): command not found/i)
    || s.match(/'([\w.+-]+)' is not recognized as an? (?:internal|external) command/i)
    || s.match(/no se reconoce.*?'([\w.+-]+)'/i)
    || s.match(/(\bpython\b) was not found/i)
    || s.match(/([\w.+-]+): not found/i);
  if (!m) return null;
  const name = m[1].trim();
  // se ignoran rutas y cosas que no son un ejecutable suelto
  if (!name || name.includes('/') || name.includes('\\') || name.length > 40) return null;
  return name;
}

// ¿El comando busca en todo el disco/raíz? (find /, find /c, grep -r … /). En Windows es lentísimo y puede colgarse.
export function wholeDriveScan(command) {
  const s = String(command || '');
  if (/\bfind\s+"?\/(c|d|e|[a-z])?\/?"?(\s+-|\s*(\||;|&|$))/i.test(s)) return 'find';
  if (/\bgrep\s+-[a-z]*[rR][a-z]*\b[^|;&]*\s"?\/(c|[a-z])?\/?"?(\s|$)/i.test(s)) return 'grep';
  return null;
}

// Cómo instalar un programa conocido (Windows con winget por defecto).
const WINGET = {
  '7z': '7zip.7zip', '7za': '7zip.7zip', python: 'Python.Python.3.12', python3: 'Python.Python.3.12',
  git: 'Git.Git', node: 'OpenJS.NodeJS', make: 'GnuWin32.Make', gcc: 'MSYS2.MSYS2', cmake: 'Kitware.CMake',
  ffmpeg: 'Gyan.FFmpeg', jq: 'jqlang.jq', wget: 'JernejSimoncic.Wget', rg: 'BurntSushi.ripgrep.MSVC',
  docker: 'Docker.DockerDesktop', gh: 'GitHub.cli', go: 'GoLang.Go', rustc: 'Rustlang.Rustup', cargo: 'Rustlang.Rustup',
};
export function installHint(program) {
  const p = String(program).toLowerCase();
  if (process.platform === 'win32') {
    const id = WINGET[p];
    return id ? `winget install ${id}` : `winget search ${program}`;
  }
  if (process.platform === 'darwin') return `brew install ${program}`;
  return `sudo apt install ${program}`;
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
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 120000, max 600000). Use a large value for installs or builds.' },
    },
    required: ['command'],
  },
  summary: (a) => String(a.command || '').replace(/\s+/g, ' ').slice(0, 120),
  permissionKey: (a) => String(a.command || '').trim(),
  preview: (a) => ({ kind: 'command', command: a.command, description: a.description }),
  sandboxable: true,
  async run(a, ctx) {
    // el timeout es en milisegundos, pero muchos modelos lo pasan en segundos (p. ej. 120 por 2 min):
    // un valor menor a 1000 se interpreta como segundos para no matar el comando en una fracción de segundo
    let timeout = Number(a.timeout) || 120000;
    if (timeout > 0 && timeout < 1000) timeout *= 1000;
    timeout = Math.min(Math.max(timeout, 1000), 600000);
    const rt = ctx.runtime;
    const command = String(a.command);
    // búsqueda en todo el disco (find /c, grep -r /): no se ejecuta, se redirige a las herramientas rápidas, que
    // en Windows son muchísimo más veloces y no se cuelgan con las junctions del sistema
    if (process.platform === 'win32' && wholeDriveScan(command)) {
      return {
        content: 'Not run: this searches the whole drive, which is extremely slow on Windows and can hang. Use the Glob tool to find files by name/pattern (e.g. "**/pcap.h"), or the Grep tool to search file contents. If you really need a shell search, point it at a specific folder, not / or /c.',
        display: L('búsqueda en todo el disco evitada · usa Glob/Grep', 'whole-drive search avoided · use Glob/Grep'),
        isError: true,
      };
    }
    // muestra en vivo la última línea de salida en el spinner, para que un comando largo no parezca trabado
    const onProgress = (line) => rt.spinner?.active && rt.spinner.setVerb?.(`Bash · ${line.length > 72 ? `${line.slice(0, 71)}…` : line}`);
    const base = { cwd: ctx.cwd, timeout, signal: ctx.signal, shell: detectShell(rt.settings), onProgress };
    const boxed = (st) => ({ ...base, sandbox: { status: st, projectRoot: rt.projectRoot, onStatus: (m) => rt.spinner?.setVerb?.(m) } });
    let st = sandboxStatus(rt.settings);
    if (st.mode === 'strict' && !st.active) {
      return { content: `The sandbox is required (strict mode) but unavailable: ${st.problem}. Ask the user to fix it or change the mode with /sandbox.`, display: L('sandbox no disponible', 'sandbox unavailable'), isError: true };
    }
    let r = await runShell(command, st.active ? boxed(st) : base);
    let note = '';
    let block = st.active ? detectBlock(r.output, r) : null;
    // un fallo de red hacia un dominio ya permitido no es culpa del sandbox
    if (block?.kind === 'network' && block.host && hostAllowed(block.host, st.allowedDomains)) block = null;
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
    if (r.killed === 'timeout') out += `\n[command stopped: exceeded the ${Math.round(timeout / 1000)} s timeout. If it just needs more time, run it again with a larger timeout.]`;
    // falta de permisos de administrador (Windows): se le muestra al usuario el comando listo para pegar en una
    // PowerShell elevada, igual que el "!" para que lo corra él; el agente no debe reintentarlo en bucle.
    // También cuando un comando que suele necesitar admin (choco/winget/msiexec…) no terminó bien —aunque un
    // "| head" haya disfrazado el código de salida como 0.
    const chocoFailed = /was NOT successful|no fue satisfactori|not install|Access is denied|falló la instalaci|exited -?[1-9]/i.test(out);
    const elevation = process.platform === 'win32' && (
      (r.code !== 0 && needsElevation(out))
      || (adminCommand(command) && (r.code !== 0 || needsElevation(out) || chocoFailed))
    );
    if (elevation) {
      const cmd = cleanCommand(command);
      ctx.ui?.markdown?.(`${L('⚡ Administrador necesario', '⚡ Administrator needed')}\n${elevatedHint(cmd)}`);
      out += `\n[this command needs Administrator rights on Windows and cannot run from this normal shell. I have shown the user the exact command to run in an elevated PowerShell (${cmd}). Do not retry it here; wait for the user or continue with the rest of the task.]`;
    }
    // un programa que no está instalado: no sirve probar mil rodeos, hay que avisarle al usuario qué instalar
    const missing = r.code !== 0 && !elevation && missingProgram(out);
    if (missing) {
      const how = installHint(missing);
      ctx.ui?.markdown?.(L(`📦 Falta "${missing}"\nNo está instalado en tu sistema. Instálalo y vuelve a intentar:\n  ${how}`, `📦 "${missing}" is missing\nIt is not installed on your system. Install it and try again:\n  ${how}`));
      out += `\n[the program "${missing}" is not installed. Do not try to work around this with other tools or downloads; tell the user to install it (${how}) and continue with what does not need it.]`;
    }
    const lines = out ? out.split('\n') : [];
    const display = r.code === 0
      ? (lines.length ? `${lines.slice(0, 3).join('\n')}${lines.length > 3 ? L(`\n… ${lines.length - 3} líneas más`, `\n… ${lines.length - 3} more lines`) : ''}` : L('Sin salida', 'No output'))
      : elevation
        ? L('Necesita Administrador · te pasé el comando para ejecutarlo', 'Needs Administrator · I gave you the command to run it')
        : missing
          ? L(`Falta "${missing}" · te dije cómo instalarlo`, `"${missing}" is missing · I told you how to install it`)
          : `${L('Código de salida', 'Exit code')} ${r.code}${errorLine(lines) ? ` · ${errorLine(lines).slice(0, 120)}` : ''}`;
    return {
      content: `${out || '(no output)'}${r.code !== 0 ? `\n[exit code ${r.code}]` : ''}`,
      display,
      isError: r.code !== 0,
    };
  },
};
