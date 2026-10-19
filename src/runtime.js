// Estado de una ejecución de Códice: configuración, recursos, herramientas, MCP, permisos y uso.
import path from 'node:path';
import { loadSettings, findProjectRoot, settingsFiles, saveSetting, resolveProvider, ensureHome, HOME } from './config.js';
import { readJSON, writeJSON } from './util/fs.js';
import { setTheme, currentTheme, setColorLevel, detectColorLevel, c, visibleWidth } from './ui/theme.js';
import { loadMascots, resolveMascot, mascotVerbs } from './ui/mascot.js';
import { Spinner, configureOutput, warn, redraw } from './ui/output.js';
import { createUI } from './ui/bridge.js';
import { loadSkills, loadAgents, loadCommands } from './resources.js';
import { listPlugins, pluginHooks, pluginMcpServers } from './plugins.js';
import { McpManager } from './mcp.js';
import { Permissions, MODES, MODE_INFO } from './permissions.js';
import { runHooks } from './hooks.js';
import { loadMemory } from './memory.js';
import { createClient, parseTarget } from './llm/index.js';
import { BUILTIN_TOOLS } from './tools/index.js';
import { Checkpoints } from './session.js';
import { formatTokens, formatDuration } from './util/fs.js';
import { setLanguage, L } from './i18n.js';
import { localEngine } from './local/engine.js';
import { recordUsage, estimateCost } from './usage.js';
import { sandboxStatus } from './sandbox.js';

export class Runtime {
  constructor({ cwd = process.cwd(), overrides = {} } = {}) {
    this.cwd = path.resolve(cwd);
    this.projectRoot = findProjectRoot(this.cwd);
    this.overrides = overrides; // opciones de la línea de comandos (no se guardan)
    this.readFiles = new Set();
    this.todos = [];
    this.usage = { input: 0, output: 0, requests: 0, ms: 0, outputMs: 0, byModel: {} };
    this.toolModes = {};
    this.spinner = new Spinner();
    this.checkpoints = new Checkpoints();
    this.ui = createUI({});
    this.sessionId = null;
    this.lastToolOutput = null;
    this.permissions = new Permissions(this);
    this.mcp = new McpManager({ cwd: this.cwd });
    localEngine.onStatus = (msg) => { if (this.spinner.active) this.spinner.setVerb(msg); };
    ensureHome();
    this.reload();
    this.permissionMode = this.overrides.permissionMode || this.settings.permissions?.mode || 'default';
    if (!MODES.includes(this.permissionMode)) this.permissionMode = 'default';
  }

  reload() {
    const s = loadSettings(this.projectRoot);
    const o = this.overrides;
    if (o.provider) s.provider = o.provider;
    if (o.model) s.model = o.model;
    if (o.baseUrl) { s.providers = { ...s.providers, cli: { type: o.providerType || 'openai', baseUrl: o.baseUrl, apiKey: o.apiKey, label: o.baseUrl.replace(/^https?:\/\//, '').replace(/\/v1\/?$/, '') } }; s.provider = 'cli'; }
    if (o.toolMode) s.toolMode = o.toolMode;
    if (o.offline) s.offline = true;
    if (o.screenReader) s.accessibility = { ...s.accessibility, screenReader: true };
    if (o.reduceMotion) s.accessibility = { ...s.accessibility, reduceMotion: true };
    if (o.noColor) s.accessibility = { ...s.accessibility, noColor: true };
    if (o.theme) s.theme = o.theme;
    this.settings = s;
    setLanguage(s.language);
    this.localSettings = readJSON(settingsFiles(this.projectRoot).local, {});
    if (process.env.REDUCE_MOTION) s.accessibility.reduceMotion = true;
    setColorLevel(s.accessibility.screenReader || s.accessibility.noColor ? 0 : detectColorLevel());
    configureOutput({ screenReader: Boolean(s.accessibility.screenReader), reduceMotion: Boolean(s.accessibility.reduceMotion) });
    const th = setTheme(s.theme, s.customThemes);
    this.themeWarnings = th.warnings;
    this.plugins = listPlugins(s).filter((p) => p.enabled);
    const opts = { projectRoot: this.projectRoot, plugins: this.plugins, compat: s.compat?.claude !== false };
    this.skills = loadSkills(opts);
    this.agents = loadAgents(opts);
    this.commands = loadCommands(opts);
    this.mascots = loadMascots();
    this.memory = loadMemory(this.cwd, this.projectRoot, { compat: s.compat?.claude !== false });
  }

  get offline() { return Boolean(this.settings.offline); }

  // Modo ligero: true/false explícito, o 'auto' (ligero salvo con proveedores en la nube).
  isLean() {
    const v = this.settings.lean;
    if (v === true || v === false) return v;
    return !this.providerInfo()?.cloud;
  }

  mascot() { return resolveMascot(this.settings, this.mascots); }
  spinnerVerbs() { return mascotVerbs(this.mascot(), this.settings); }

  // ── Persistencia de ajustes ────────────────────────────────────
  save(keyPath, value, scope = 'user') {
    const file = saveSetting(this.projectRoot, scope, keyPath, value);
    this.reload();
    // lo que se ve en la bienvenida o en los colores: se vuelve a dibujar la pantalla en su lugar
    if (/^(model|provider|theme|mascot|themeMascots|language|sandbox\.mode)(\.|$)/.test(keyPath) && !this.redrawPending) {
      this.redrawPending = true;
      setImmediate(() => { this.redrawPending = false; redraw(); });
    }
    return file;
  }

  setPermissionMode(mode) {
    if (MODES.includes(mode)) this.permissionMode = mode;
  }

  // shift+tab: default → acceptEdits → plan → default. bypass solo con /mode bypass o --yolo.
  cycleMode() {
    const cycle = ['default', 'acceptEdits', 'plan'];
    const i = cycle.indexOf(this.permissionMode);
    this.permissionMode = cycle[(i + 1) % cycle.length];
    return this.permissionMode;
  }

  // ── Modelos ────────────────────────────────────────────────────
  createClient({ provider, model } = {}) {
    let p = provider || this.settings.provider;
    let m = model || this.settings.model;
    if (model && !provider) ({ provider: p, model: m } = parseTarget(model, this.settings));
    return createClient(this.settings, {
      provider: p,
      model: m,
      onFallback: (next, err) => warn(L(`${err.message}. Uso el respaldo ${next.provider}:${next.model}.`, `${err.message}. Using fallback ${next.provider}:${next.model}.`)),
    });
  }

  providerInfo() {
    return resolveProvider(this.settings, this.settings.provider);
  }

  contextWindow() {
    return this.providerInfo()?.contextWindow || this.settings.contextWindow || 16384;
  }

  toolModeFor(model) {
    if (this.settings.toolMode === 'native' || this.settings.toolMode === 'prompt') return this.settings.toolMode;
    return this.toolModes[model] || readJSON(path.join(HOME, 'tool-modes.json'), {})[model] || 'native';
  }

  setToolMode(model, mode) {
    this.toolModes[model] = mode;
    try {
      const file = path.join(HOME, 'tool-modes.json');
      writeJSON(file, { ...readJSON(file, {}), [model]: mode });
    } catch { /* caché opcional */ }
  }

  addUsage(usage, client, ms) {
    this.usage.requests++;
    this.usage.ms += ms || 0;
    if (!usage) return;
    this.usage.input += usage.input || 0;
    this.usage.output += usage.output || 0;
    this.usage.cached = (this.usage.cached || 0) + (usage.cached || 0);
    const key = `${client.providerName}:${client.model}`;
    const u = (this.usage.byModel[key] ||= { input: 0, output: 0, requests: 0, ms: 0, cost: 0 });
    u.input += usage.input || 0;
    u.output += usage.output || 0;
    u.requests++;
    u.ms += usage.evalDurationNs ? usage.evalDurationNs / 1e6 : ms || 0;
    // costo: el real si el proveedor lo informa (OpenRouter) o el estimado con settings.pricing
    const cost = usage.cost ?? estimateCost(this.settings.pricing, client.providerName, client.model, usage);
    if (cost != null) { u.cost += cost; this.usage.cost = (this.usage.cost || 0) + cost; }
    const info = client.provider || {};
    recordUsage({ provider: client.providerName, model: client.model, usage, cost, kind: info.type === 'codice' ? 'remota' : info.cloud ? 'nube' : 'local' });
    const rl = client.current?.lastRateLimits ?? client.lastRateLimits;
    if (rl) (this.rateLimits ||= {})[client.providerName] = rl;
  }

  // ── Herramientas y extensiones ─────────────────────────────────
  allTools() {
    return [...BUILTIN_TOOLS, ...this.mcp.tools()];
  }

  mcpConfigs() {
    const out = {};
    for (const p of this.plugins) Object.assign(out, pluginMcpServers(p));
    Object.assign(out, readJSON(path.join(this.projectRoot, '.mcp.json'), {})?.mcpServers || {});
    Object.assign(out, this.settings.mcpServers || {});
    return out;
  }

  async startMcp() {
    const cfgs = this.mcpConfigs();
    if (Object.keys(cfgs).length) await this.mcp.startAll(cfgs);
  }

  hooksConfig() {
    const merged = {};
    const add = (h) => { for (const [ev, groups] of Object.entries(h || {})) merged[ev] = [...(merged[ev] || []), ...(Array.isArray(groups) ? groups : [])]; };
    add(this.settings.hooks);
    for (const p of this.plugins) add(pluginHooks(p));
    return merged;
  }

  async hook(event, payload, target = null) {
    const cfg = this.hooksConfig();
    if (!cfg[event]?.length) return { blocked: false, reason: '', context: '' };
    return runHooks(cfg, event, payload, { target, cwd: this.cwd, sessionId: this.sessionId, projectDir: this.projectRoot });
  }

  // ── Subagentes ─────────────────────────────────────────────────
  async runSubagent(type, prompt, { signal, depth = 1, description } = {}) {
    const def = this.agents[type] || Object.values(this.agents).find((a) => a.name.toLowerCase() === String(type).toLowerCase());
    if (!def) throw new Error(L(`No existe el agente "${type}". Disponibles: ${Object.keys(this.agents).join(', ')}`, `Agent "${type}" does not exist. Available: ${Object.keys(this.agents).join(', ')}`));
    const { Agent, subView } = await import('./agent/agent.js');
    const override = this.settings.agentModels?.[def.name];
    let provider = def.provider || null;
    let model = def.model || null;
    if (override) ({ provider, model } = parseTarget(override, this.settings));
    else if (model && !provider) ({ provider, model } = parseTarget(model, this.settings));
    const label = def.name.split(':').pop();
    const agent = new Agent(this, { def, depth, label, view: subView(this, label), provider, model });
    const r = await agent.run(prompt, { signal });
    await this.hook('SubagentStop', { agent: def.name, description, result: r.text?.slice(0, 2000) });
    return r;
  }

  // ── Estado ─────────────────────────────────────────────────────
  modeLabel() {
    const info = MODE_INFO[this.permissionMode];
    return { text: `${info.label}${L(' · shift+tab cambia', ' · shift+tab cycles')}`, color: info.color };
  }

  statusLine(agent) {
    const m = this.modeLabel();
    const mode = m.color === 'status/agent' ? c.agent(m.text) : m.color === 'status/warning' ? c.warning(m.text) : m.color === 'status/error' ? c.error(m.text) : c.muted(m.text);
    // datos de la derecha por prioridad: si no caben, se quitan los últimos
    const parts = [this.settings.model || L('sin modelo', 'no model')];
    if (agent) {
      try {
        const u = agent.contextUsage();
        const pct = Math.min(100, Math.round((u.used / u.max) * 100));
        const auto = Math.round((Number(this.settings.autoCompact) || 0) * 100);
        // aviso como en Claude Code: cuánto falta para compactar automáticamente
        parts.push(auto && pct >= auto - 15 ? L(`${Math.max(0, auto - pct)} % para autocompactar`, `${Math.max(0, auto - pct)}% until auto-compact`) : `ctx ${pct} %`);
      } catch { /* sin estimación */ }
    }
    if (this.offline) parts.push('offline');
    if (this.lastResponseMs) parts.push(L(`última ${formatDuration(this.lastResponseMs)}`, `last ${formatDuration(this.lastResponseMs)}`));
    const mcpOk = this.mcp.status().filter((s) => s.status === 'conectado').length;
    if (mcpOk) parts.push(`${mcpOk} MCP`);
    const cols = (process.stdout.columns || 80) - 1;
    const sb = this.settings.sandbox?.mode && this.settings.sandbox.mode !== 'off' ? sandboxStatus(this.settings) : null;
    const sbText = sb ? (sb.active ? c.success('⛨ sandbox') : c.warning(L('⛨ sandbox no disponible', '⛨ sandbox unavailable'))) : '';
    const sbW = sbText ? visibleWidth(sbText) + 3 : 0;
    while (parts.length > 1 && 2 + visibleWidth(mode) + 3 + sbW + visibleWidth(parts.join(' · ')) > cols) parts.pop();
    const right = `${sbText}${sbText ? c.dim(' · ') : ''}${c.dim(parts.join(' · '))}`;
    const gap = cols - 2 - visibleWidth(mode) - visibleWidth(right);
    return gap >= 3 ? `  ${mode}${' '.repeat(gap)}${right}` : `  ${mode}`;
  }

  themeName() { return currentTheme().name; }
}
