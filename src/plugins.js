// Plugins: carpetas con plugin.json que agrupan skills, agentes, comandos, hooks y servidores MCP.
// Compatible con el formato de Claude Code (.claude-plugin/plugin.json y marketplace.json).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { HOME } from './config.js';
import { readJSON, listDirs } from './util/fs.js';

const MANIFESTS = ['.codice-plugin/plugin.json', '.claude-plugin/plugin.json', 'plugin.json'];
const MARKETS = ['.codice-plugin/marketplace.json', '.claude-plugin/marketplace.json', 'marketplace.json'];
export const PLUGINS_DIR = () => path.join(HOME, 'plugins');

export function readManifest(dir) {
  for (const m of MANIFESTS) {
    const j = readJSON(path.join(dir, m));
    if (j) return j;
  }
  // sin manifiesto: se acepta si trae carpetas de recursos
  if (['skills', 'agents', 'commands'].some((d) => fs.existsSync(path.join(dir, d)))) return { name: path.basename(dir) };
  return null;
}

export function readMarketplace(dir) {
  for (const m of MARKETS) {
    const j = readJSON(path.join(dir, m));
    if (j?.plugins) return j;
  }
  return null;
}

export function listPlugins(settings) {
  const out = [];
  for (const d of listDirs(PLUGINS_DIR())) {
    const root = path.join(PLUGINS_DIR(), d);
    const man = readManifest(root);
    if (!man) continue;
    const name = man.name || d;
    out.push({ name, version: man.version || '', description: man.description || '', root, enabled: settings.enabledPlugins?.[name] !== false });
  }
  return out;
}

export function pluginHooks(plugin) {
  const j = readJSON(path.join(plugin.root, 'hooks', 'hooks.json'));
  if (!j) return {};
  const hooks = j.hooks || j;
  const out = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    out[event] = groups.map((g) => ({ ...g, pluginRoot: plugin.root }));
  }
  return out;
}

export function pluginMcpServers(plugin) {
  const j = readJSON(path.join(plugin.root, '.mcp.json'));
  const servers = j?.mcpServers || {};
  const sub = (v) => (typeof v === 'string' ? v.replace(/\$\{(CODICE|CLAUDE)_PLUGIN_ROOT\}/g, plugin.root) : v);
  const out = {};
  for (const [name, cfg] of Object.entries(servers)) {
    out[`${plugin.name}-${name}`] = {
      ...cfg,
      command: sub(cfg.command),
      args: (cfg.args || []).map(sub),
      env: Object.fromEntries(Object.entries(cfg.env || {}).map(([k, v]) => [k, sub(v)])),
      url: sub(cfg.url),
    };
  }
  return out;
}

function isGitSource(s) {
  return /^(https?:\/\/|git@|ssh:\/\/)/.test(s) || /^[\w.-]+\/[\w.-]+$/.test(s);
}

function gitClone(src, dest) {
  const url = /^[\w.-]+\/[\w.-]+$/.test(src) ? `https://github.com/${src}.git` : src;
  const r = spawnSync('git', ['clone', '--depth', '1', url, dest], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git clone falló: ${(r.stderr || r.error?.message || '').trim()}`);
}

// source: carpeta local, URL git, "usuario/repo" o "plugin@origen" (marketplace).
export function installPlugin(source) {
  let pluginName = null;
  let src = source.trim();
  const at = src.match(/^([\w.-]+)@(.+)$/);
  if (at && !src.startsWith('git@')) { pluginName = at[1]; src = at[2]; }

  let base = src;
  let tmp = null;
  if (!fs.existsSync(src)) {
    if (!isGitSource(src)) throw new Error(`No encuentro "${src}" (ni carpeta local ni repositorio git)`);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codice-plugin-'));
    gitClone(src, path.join(tmp, 'repo'));
    base = path.join(tmp, 'repo');
  }
  try {
    let pluginDir = base;
    const market = readMarketplace(base);
    if (market && (pluginName || !readManifest(base))) {
      if (!pluginName) {
        const names = market.plugins.map((p) => p.name).join(', ');
        throw Object.assign(new Error(`Es un marketplace. Elige un plugin: ${names}. Ejemplo: /plugin install ${market.plugins[0]?.name}@${source}`), { marketplace: market.plugins });
      }
      const entry = market.plugins.find((p) => p.name === pluginName);
      if (!entry) throw new Error(`El marketplace no contiene "${pluginName}"`);
      const s = entry.source;
      if (typeof s === 'string' && !isGitSource(s)) pluginDir = path.resolve(base, s);
      else {
        const repo = typeof s === 'string' ? s : s.repo || s.url;
        const sub = path.join(tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'codice-plugin-')), 'sub');
        gitClone(repo, sub);
        pluginDir = sub;
      }
    }
    const man = readManifest(pluginDir);
    if (!man) throw new Error('No parece un plugin: falta plugin.json y no tiene skills/, agents/ ni commands/');
    const name = String(man.name || path.basename(pluginDir)).replace(/[^\w.-]/g, '-');
    const dest = path.join(PLUGINS_DIR(), name);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(PLUGINS_DIR(), { recursive: true });
    fs.cpSync(pluginDir, dest, { recursive: true, filter: (p) => !p.split(path.sep).includes('.git') });
    return { name, version: man.version || '', root: dest, description: man.description || '' };
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function removePlugin(name) {
  const dest = path.join(PLUGINS_DIR(), name);
  if (!fs.existsSync(dest)) throw new Error(`No está instalado el plugin "${name}"`);
  fs.rmSync(dest, { recursive: true, force: true });
}
