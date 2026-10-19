// Sandbox para los comandos del agente (herramienta Bash): solo puede escribir en la carpeta del proyecto y en una
// carpeta temporal propia, y no tiene red salvo los dominios permitidos (a través de un proxy local que filtra).
// Motores: bubblewrap (Linux), sandbox-exec (macOS) y Docker (Windows, o donde se elija).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { HOME } from './config.js';
import { L } from './i18n.js';

export const SANDBOX_MODES = ['off', 'auto', 'strict'];

const which = (cmd) => {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
};

let detected = null;

// { engine: { name, label } | null, problem: texto | null }
export function detectEngine({ refresh = false, prefer } = {}) {
  const forced = process.env.CODICE_SANDBOX_ENGINE;
  if (forced) return forced === 'none' ? { engine: null, problem: 'CODICE_SANDBOX_ENGINE=none' } : { engine: { name: forced, label: forced }, problem: null };
  if (detected && !refresh && !prefer) return detected;
  let result;
  const want = prefer || (process.platform === 'linux' ? 'bwrap' : process.platform === 'darwin' ? 'seatbelt' : 'docker');
  if (want === 'bwrap') {
    if (!which('bwrap')) result = { engine: null, problem: L('falta bubblewrap (instálalo: sudo apt install bubblewrap)', 'bubblewrap is missing (install it: sudo apt install bubblewrap)') };
    else {
      const r = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-net', 'true'], { encoding: 'utf8' });
      result = r.status === 0
        ? { engine: { name: 'bwrap', label: 'bubblewrap' }, problem: null }
        : { engine: null, problem: L(`bubblewrap no puede crear el sandbox: ${(r.stderr || '').trim().slice(0, 120)}`, `bubblewrap cannot create the sandbox: ${(r.stderr || '').trim().slice(0, 120)}`) };
    }
  } else if (want === 'seatbelt') {
    result = fs.existsSync('/usr/bin/sandbox-exec')
      ? { engine: { name: 'seatbelt', label: 'sandbox-exec' }, problem: null }
      : { engine: null, problem: L('sandbox-exec no está disponible', 'sandbox-exec is not available') };
  } else {
    const r = spawnSync('docker', ['info', '--format', '{{.OSType}}'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    if (r.error?.code === 'ENOENT') result = { engine: null, problem: L('falta Docker Desktop (instálalo desde docker.com)', 'Docker Desktop is missing (install it from docker.com)') };
    else if (r.error) result = { engine: null, problem: L('Docker no responde (revisa Docker Desktop)', 'Docker is not responding (check Docker Desktop)') };
    else if (r.status !== 0) result = { engine: null, problem: L('Docker está instalado pero no está corriendo (abre Docker Desktop)', 'Docker is installed but not running (open Docker Desktop)') };
    else if (r.stdout.trim() !== 'linux') result = { engine: null, problem: L('Docker usa contenedores de Windows; cambia a contenedores de Linux', 'Docker is using Windows containers; switch to Linux containers') };
    else result = { engine: { name: 'docker', label: 'Docker' }, problem: null };
  }
  if (!prefer) detected = result;
  return result;
}

export function sandboxConfig(settings = {}) {
  const s = settings.sandbox || {};
  return {
    mode: SANDBOX_MODES.includes(s.mode) ? s.mode : 'off',
    allowedDomains: [...new Set((s.allowedDomains || []).map((d) => String(d).toLowerCase()))],
    allowWrite: s.allowWrite || [],
    autoAllow: s.autoAllow !== false,
    engine: s.engine || null,
    image: s.image || 'node:22-bookworm-slim',
  };
}

// Estado completo: modo, motor y si está activo de verdad.
export function sandboxStatus(settings = {}) {
  const cfg = sandboxConfig(settings);
  if (cfg.mode === 'off') return { ...cfg, active: false, engine: null, problem: null };
  const { engine, problem } = detectEngine({ prefer: cfg.engine || undefined });
  return { ...cfg, active: Boolean(engine), engine, problem };
}

// Carpetas propias del sandbox (temporal y cachés de npm/pip…), para que los comandos no escriban fuera.
export function sandboxDirs() {
  const base = path.join(HOME, 'sandbox');
  const tmp = path.join(base, 'tmp');
  const cache = path.join(base, 'cache');
  for (const d of [tmp, cache]) fs.mkdirSync(d, { recursive: true });
  return { tmp, cache };
}

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

export function writableDirs({ projectRoot, cwd, allowWrite = [] }) {
  const { tmp, cache } = sandboxDirs();
  return [...new Set([projectRoot, cwd, tmp, cache, ...allowWrite].filter(Boolean).map(real))];
}

function sandboxEnv({ proxyPort, proxyHost = '127.0.0.1', dirs, join = path.join }) {
  const env = { CODICE_SANDBOX: '1', TMPDIR: dirs.tmp, TMP: dirs.tmp, TEMP: dirs.tmp, XDG_CACHE_HOME: dirs.cache, npm_config_cache: join(dirs.cache, 'npm'), PIP_CACHE_DIR: join(dirs.cache, 'pip'), YARN_CACHE_FOLDER: join(dirs.cache, 'yarn') };
  if (proxyPort) {
    const url = `http://${proxyHost}:${proxyPort}`;
    Object.assign(env, { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, npm_config_proxy: url, npm_config_https_proxy: url, NO_PROXY: '', no_proxy: '' });
  }
  return env;
}

// Perfil de sandbox-exec (macOS): todo permitido salvo escribir fuera de las carpetas y usar la red.
export function seatbeltProfile({ writable, proxyPort }) {
  const q = (p) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${writable.map((p) => `(subpath ${q(p)})`).join(' ')} (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/tty") (regex #"^/dev/fd/") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/dtracehelper"))`,
    '(deny network*)',
    '(allow network* (local unix-socket))',
    proxyPort ? `(allow network-outbound (remote ip "localhost:${proxyPort}"))` : '',
  ].filter(Boolean).join('\n');
}

// Argumentos de bubblewrap (Linux): el sistema en solo lectura y las carpetas permitidas con escritura.
export function bwrapArgs({ writable, cwd, network }) {
  const args = ['--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp'];
  for (const p of writable) args.push('--bind', p, p);
  if (!network) args.push('--unshare-net');
  args.push('--chdir', cwd);
  return args;
}

export const dockerName = (projectRoot) => `codice-sb-${crypto.createHash('sha1').update(real(projectRoot)).digest('hex').slice(0, 10)}`;

// Ruta dentro del contenedor (el proyecto se monta en /workspace).
export function containerPath(projectRoot, cwd) {
  const rel = path.relative(real(projectRoot), real(cwd));
  return rel && !rel.startsWith('..') ? `/workspace/${rel.split(path.sep).join('/')}` : '/workspace';
}

const run = (cmd, args) => new Promise((resolve) => {
  const p = spawn(cmd, args, { windowsHide: true });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('error', (e) => resolve({ code: -1, out: e.message }));
  p.on('close', (code) => resolve({ code, out }));
});

// Un contenedor por proyecto que se reutiliza (arrancar uno por comando sería muy lento).
async function ensureContainer({ projectRoot, image, network, onStatus }) {
  const name = dockerName(projectRoot);
  const netLabel = network ? 'proxy' : 'none';
  const insp = await run('docker', ['inspect', '-f', '{{.State.Running}} {{index .Config.Labels "codice.net"}}', name]);
  if (insp.code === 0 && insp.out.trim() === `true ${netLabel}`) return name;
  if (insp.code === 0) await run('docker', ['rm', '-f', name]);
  onStatus?.(L('Preparando el contenedor del sandbox (la primera vez descarga la imagen)…', 'Preparing the sandbox container (the first time it downloads the image)…'));
  const args = ['run', '-d', '--name', name, '--label', `codice.net=${netLabel}`, '--network', network ? 'bridge' : 'none', '-v', `${real(projectRoot)}:/workspace`, '-w', '/workspace'];
  if (network) args.push('--add-host', 'host.docker.internal:host-gateway');
  args.push(image, 'sleep', 'infinity');
  const r = await run('docker', args);
  if (r.code !== 0) throw new Error(L(`No se pudo crear el contenedor del sandbox: ${r.out.trim().slice(0, 200)}`, `Could not create the sandbox container: ${r.out.trim().slice(0, 200)}`));
  return name;
}

export async function stopContainer(projectRoot) {
  await run('docker', ['rm', '-f', dockerName(projectRoot)]);
}

// ── Proxy que solo deja pasar los dominios permitidos ────────────
let proxy = null;

export function hostAllowed(host, allowed) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return allowed.some((d) => {
    const x = d.replace(/^\*\./, '');
    return h === x || h.endsWith(`.${x}`);
  });
}

export async function startProxy(getAllowed) {
  if (proxy) { proxy.getAllowed = getAllowed; return proxy; }
  const state = { getAllowed, lastDenied: null, port: 0, server: null };
  const deny = (sock, host) => {
    state.lastDenied = host;
    sock.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nBlocked by Codice sandbox: host ${host} is not allowed\r\n`);
  };
  const server = http.createServer((req, res) => {
    // HTTP plano: la petición trae la URL completa
    let url;
    try { url = new URL(req.url); } catch { res.writeHead(400); return res.end('Bad request'); }
    if (!hostAllowed(url.hostname, state.getAllowed())) {
      state.lastDenied = url.hostname;
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end(`Blocked by Codice sandbox: host ${url.hostname} is not allowed\n`);
    }
    const up = http.request(url, { method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  server.on('connect', (req, sock, head) => {
    // HTTPS: túnel CONNECT host:puerto
    const [host, port = '443'] = String(req.url).split(':');
    if (!hostAllowed(host, state.getAllowed())) return deny(sock, host);
    const up = net.connect(Number(port), host, () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  state.port = server.address().port;
  state.server = server;
  proxy = state;
  return state;
}

export function stopProxy() {
  proxy?.server?.close();
  proxy = null;
}

// ── Ejecutar dentro del sandbox ──────────────────────────────────
// Devuelve { file, args, env } para spawn. shellArgs = argumentos del shell para el comando (p. ej. ['-c', cmd]).
export async function sandboxSpawn({ status, command, cwd, projectRoot, shell, shellArgs, onStatus }) {
  const dirs = sandboxDirs();
  const writable = writableDirs({ projectRoot, cwd, allowWrite: status.allowWrite });
  const domains = status.allowedDomains;
  const p = domains.length ? await startProxy(() => domains) : null;
  if (p) p.lastDenied = null; // lo que bloquee el proxy durante este comando
  const name = status.engine.name;
  if (name === 'bwrap') {
    return { file: 'bwrap', args: [...bwrapArgs({ writable, cwd: real(cwd), network: Boolean(p) }), shell, ...shellArgs], env: sandboxEnv({ proxyPort: p?.port, dirs }) };
  }
  if (name === 'seatbelt') {
    return { file: '/usr/bin/sandbox-exec', args: ['-p', seatbeltProfile({ writable, proxyPort: p?.port }), shell, ...shellArgs], env: sandboxEnv({ proxyPort: p?.port, dirs }) };
  }
  if (name === 'docker') {
    const container = await ensureContainer({ projectRoot, image: status.image, network: Boolean(p), onStatus });
    const env = p ? sandboxEnv({ proxyPort: p.port, proxyHost: 'host.docker.internal', dirs: { tmp: '/tmp', cache: '/tmp/cache' }, join: path.posix.join }) : { CODICE_SANDBOX: '1' };
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    return { file: 'docker', args: ['exec', '-i', '-w', containerPath(projectRoot, cwd), ...envArgs, container, 'sh', '-c', command], env: {} };
  }
  throw new Error(`Unknown sandbox engine: ${name}`);
}

// ¿El comando falló porque el sandbox lo bloqueó? → { kind: 'network'|'write', host?, path? } | null
export function detectBlock(output, { code } = {}) {
  const denied = proxy?.lastDenied || null;
  if (proxy) proxy.lastDenied = null;
  if (code === 0) return null;
  const out = String(output || '');
  // el proxy rechazó un dominio no permitido (npm, pip, git… muestran un 403 genérico)
  if (denied) return { kind: 'network', host: denied };
  const net = /Blocked by Codice sandbox|ENOTFOUND|EAI_AGAIN|getaddrinfo|Could not resolve host|Temporary failure in name resolution|Network is unreachable|Name or service not known|nodename nor servname|Failed to establish a new connection|tunneling socket could not be established|connect EPERM|Operation not permitted.*(connect|socket)|fetch failed/i;
  if (net.test(out)) {
    const m = out.match(/Blocked by Codice sandbox: host ([\w.-]+)/) || out.match(/ENOTFOUND ([\w.-]+)/) || out.match(/EAI_AGAIN ([\w.-]+)/)
      || out.match(/resolve host:?\s*'?([\w.-]+)/i) || out.match(/https?:\/\/([\w.-]+\.[a-z]{2,})/i);
    return { kind: 'network', host: m?.[1] || proxy?.lastDenied || null };
  }
  const line = out.split('\n').find((l) => /Read-only file system|EROFS/i.test(l)) || out.split('\n').find((l) => /EPERM|Operation not permitted/i.test(l));
  if (!line) return null;
  const p = line.match(/'([^']+)'|"([^"]+)"|((?:[A-Za-z]:)?[\\/][^\s:'"]+)/);
  return { kind: 'write', path: p ? p[1] || p[2] || p[3] : null };
}

// Texto corto para la bienvenida y el panel.
export function describeSandbox(st) {
  if (st.mode === 'off') return L('apagado', 'off');
  if (!st.active) return L(`no disponible: ${st.problem}`, `unavailable: ${st.problem}`);
  const net = st.allowedDomains.length ? L(`red solo a ${st.allowedDomains.join(', ')}`, `network only to ${st.allowedDomains.join(', ')}`) : L('sin red', 'no network');
  return L(`activo · solo esta carpeta · ${net} · ${st.engine.label}`, `on · this folder only · ${net} · ${st.engine.label}`);
}
