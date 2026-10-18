// Consola interactiva de Códice.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, VERSION } from './config.js';
import { c } from './ui/theme.js';
import * as ui from './ui/output.js';
import { Input } from './ui/input.js';
import { select } from './ui/select.js';
import { createUI } from './ui/bridge.js';
import { Agent } from './agent/agent.js';
import { BUILTIN_COMMANDS } from './commands/builtin.js';
import { expandCommand } from './resources.js';
import { addMemory } from './memory.js';
import { Session } from './session.js';
import { runShell } from './tools/bash.js';
import { resolvePath, relPath, truncateMiddle, isBinaryBuffer, formatDuration } from './util/fs.js';
import { LLMError } from './llm/index.js';

// Adjunta archivos mencionados con @ruta.
export function expandMentions(text, cwd) {
  const attached = [];
  let extra = '';
  const re = /(^|\s)@("[^"]+"|[^\s,;]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[2].replace(/^"|"$/g, '');
    const p = resolvePath(raw, cwd);
    if (!fs.existsSync(p)) continue;
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      const list = fs.readdirSync(p, { withFileTypes: true }).slice(0, 200).map((d) => (d.isDirectory() ? `${d.name}/` : d.name)).join('\n');
      extra += `\n\n<directory path="${relPath(p, cwd)}">\n${list}\n</directory>`;
      attached.push(`${relPath(p, cwd)}/`);
    } else if (st.size <= 256 * 1024) {
      const buf = fs.readFileSync(p);
      if (isBinaryBuffer(buf)) continue;
      extra += `\n\n<file path="${relPath(p, cwd)}">\n${buf.toString('utf8')}\n</file>`;
      attached.push(relPath(p, cwd));
    }
  }
  return { text: text + extra, attached };
}

export function describeError(e, runtime) {
  const provider = runtime.settings.provider;
  if (e instanceof LLMError) {
    if (e.network) return [`No se pudo conectar con ${provider}`, e.message.replace(/^No se pudo conectar con [^(]+/, '').replace(/[()]/g, '').trim(), provider === 'ollama' ? '¿Está en marcha? Ejecuta "ollama serve" o cambia de proveedor con /provider' : 'Revisa que el servidor esté encendido y la URL sea correcta (/provider), o usa /doctor'];
    if (e.status === 401 || e.status === 403) return ['El proveedor rechazó la API key', `HTTP ${e.status}`, 'Revisa la variable de entorno de la API key o el token de tu PC remota'];
    if (e.status === 404) return [`El modelo "${runtime.settings.model}" no está disponible`, `HTTP 404 en ${provider}`, provider === 'ollama' ? `Descárgalo con "ollama pull ${runtime.settings.model}" o elige otro con /models` : 'Elige otro modelo con /models'];
    if (e.status === 400 && /context|token/i.test(e.body)) return ['La conversación excede el contexto del modelo', `HTTP 400`, 'Usa /compact o aumenta contextWindow con /config set contextWindow 32768'];
  }
  return ['Ocurrió un error', e.message, null];
}

// Elige un modelo si no hay ninguno configurado.
export async function ensureModel(runtime, { input = null } = {}) {
  if (runtime.settings.model) return true;
  let models;
  try {
    models = await runtime.createClient({ model: 'x' }).listModels();
  } catch (e) {
    const [t, cause, action] = describeError(e, runtime);
    ui.errorBox(t, cause, action);
    return false;
  }
  if (!models.length) {
    ui.warn(runtime.settings.provider === 'ollama' ? 'Ollama no tiene modelos. Descarga uno, por ejemplo: ollama pull qwen2.5-coder:7b' : 'El proveedor no tiene modelos disponibles.');
    return false;
  }
  let pick = models[0].id;
  const coder = models.find((m) => /coder|code/i.test(m.id));
  if (models.length > 1 && input) {
    pick = await select(input, { title: 'Elige un modelo para empezar', options: models.map((m) => ({ label: m.id, value: m.id, hint: m.size ? `${(m.size / 1e9).toFixed(1)} GB` : '' })), initial: coder ? models.indexOf(coder) : 0 });
    if (!pick) return false;
  } else if (coder) pick = coder.id;
  runtime.save('model', pick);
  ui.success(`Modelo: ${pick}`);
  return true;
}

class Repl {
  constructor(runtime, input, session) {
    this.runtime = runtime;
    this.input = input;
    this.session = session;
    this.agent = new Agent(runtime, { messages: session.messages });
    this.controller = null;
    this.pendingContext = '';
    this.lastCtrlC = 0;
    this.statusOverride = null;
    this.exiting = false;
  }

  commandList() {
    const rt = this.runtime;
    const out = [];
    for (const [name, cmd] of Object.entries(BUILTIN_COMMANDS)) out.push({ name: `/${name}`, description: cmd.description, source: 'integrado' });
    for (const cmd of Object.values(rt.commands)) out.push({ name: `/${cmd.name}`, description: cmd.description, source: cmd.source.startsWith('plugin') ? cmd.source : 'personalizado' });
    for (const s of Object.values(rt.skills)) out.push({ name: `/${s.name}`, description: s.description, source: 'skill' });
    for (const p of rt.mcp.prompts()) out.push({ name: `/${p.name}`, description: p.description, source: 'MCP' });
    return out;
  }

  status() {
    return this.statusOverride ? `  ${c.warning(this.statusOverride)}` : this.runtime.statusLine(this.agent);
  }

  async welcome() {
    const rt = this.runtime;
    const p = rt.providerInfo();
    const res = [
      `${Object.keys(rt.skills).length} skills`,
      `${Object.keys(rt.agents).length} agentes`,
      `${rt.mcp.status().filter((s) => s.status === 'conectado').length} MCP`,
      `${rt.plugins.length} plugins`,
    ];
    ui.banner({
      version: VERSION,
      model: rt.settings.model,
      provider: rt.settings.provider,
      providerUrl: p?.baseUrl?.replace(/^https?:\/\//, ''),
      cwd: rt.cwd,
      memory: rt.memory.map((m) => m.name),
      resources: c.agent(res[0]) + c.dim(' · ') + c.agent(res[1]) + c.dim(' · ') + c.info(`${res[2]} ◆`) + c.dim(' · ') + c.info(res[3]),
      mascot: rt.mascot(),
    });
    for (const s of rt.mcp.status().filter((x) => x.status !== 'conectado')) ui.warn(`MCP ${s.name} no conectó: ${s.error}`);
    for (const w of rt.themeWarnings || []) ui.warn(`Tema con poco contraste: ${w}`);
    if (this.session.messages.length) ui.hint(`Conversación retomada (${this.session.messages.length} mensajes).`);
    await ensureModel(rt, { input: this.input });
  }

  async readInput() {
    ui.ensureNewline();
    let line = await this.input.prompt(`${c.accent('›', { bold: true })} `);
    if (line === null) return null;
    while (line.endsWith('\\')) {
      const more = await this.input.prompt(`${c.dim('…')} `);
      if (more === null) break;
      line = `${line.slice(0, -1)}\n${more}`;
    }
    return line;
  }

  async loop() {
    while (!this.exiting) {
      const line = await this.readInput();
      if (line === null) { await this.exit(); break; }
      try {
        await this.handle(line);
      } catch (e) {
        this.showError(e);
      }
    }
  }

  async handle(line) {
    const text = line.trim();
    if (!text) return;
    if (text.startsWith('/')) return this.command(text);
    if (text.startsWith('!')) return this.shell(text.slice(1).trim());
    if (text.startsWith('#') && !text.startsWith('##')) {
      const f = addMemory(this.runtime.projectRoot, text.slice(1));
      this.runtime.reload();
      return ui.success(`Guardado en memoria (${relPath(f, this.runtime.cwd)})`);
    }
    return this.runPrompt(text);
  }

  async command(text) {
    const [rawName, ...rest] = text.slice(1).split(/\s+/);
    const args = text.slice(1 + rawName.length).trim();
    const name = rawName.toLowerCase();
    const ctx = { runtime: this.runtime, repl: this };
    const builtin = BUILTIN_COMMANDS[name] || Object.values(BUILTIN_COMMANDS).find((cmd) => cmd.aliases?.includes(name));
    if (builtin) {
      this.input.setBusy(true);
      try { await builtin.run(args, ctx); } finally { this.input.setBusy(false); }
      return;
    }
    const custom = this.runtime.commands[rawName];
    if (custom) {
      const prompt = await expandCommand(custom, args, { runShell, cwd: this.runtime.cwd });
      return this.runPrompt(prompt, { display: text, model: custom.model });
    }
    const skill = this.runtime.skills[rawName];
    if (skill) return this.runPrompt(`Use the "${skill.name}" skill (load it with the Skill tool and follow it).${args ? `\n\n${args}` : ''}`, { display: text });
    const mcpPrompt = this.runtime.mcp.prompts().find((p) => p.name === rawName);
    if (mcpPrompt) {
      const argNames = (mcpPrompt.prompt.arguments || []).map((a) => a.name);
      const values = Object.fromEntries(argNames.map((n, i) => [n, rest[i] ?? '']));
      const content = await mcpPrompt.client.getPrompt(mcpPrompt.prompt.name, values);
      return this.runPrompt(content, { display: text });
    }
    ui.warn(`Comando desconocido: /${rawName}. Escribe /help para ver la lista.`);
  }

  async shell(cmd) {
    if (!cmd) return;
    const r = await runShell(cmd, { cwd: this.runtime.cwd, timeout: 300000 });
    const outText = r.output.replace(/\r\n/g, '\n').trimEnd();
    const lines = outText.split('\n');
    for (const l of lines.slice(0, 40)) ui.println(c.muted(l));
    if (lines.length > 40) ui.hint(`… ${lines.length - 40} líneas más (se añadieron completas al contexto)`);
    if (r.code !== 0) ui.println(c.error(`código de salida ${r.code}`));
    this.pendingContext += `\n<bash-input>${cmd}</bash-input>\n<bash-output>\n${truncateMiddle(outText, 20000)}\n</bash-output>`;
  }

  async runPrompt(text, { display = null } = {}) {
    const rt = this.runtime;
    if (!rt.settings.model && !(await ensureModel(rt, { input: this.input }))) return;
    const { text: withFiles, attached } = expandMentions(text, rt.cwd);
    if (attached.length) ui.hint(`Adjuntado: ${attached.join(', ')}`);
    if (display) ui.println(c.dim(display));
    const hook = await rt.hook('UserPromptSubmit', { prompt: text });
    if (hook.blocked) return ui.warn(`Bloqueado por un hook: ${hook.reason}`);
    let content = withFiles;
    if (this.pendingContext) { content = `${this.pendingContext.trim()}\n\n${content}`; this.pendingContext = ''; }
    if (hook.context) content += `\n\n<hook-context>\n${hook.context}\n</hook-context>`;
    rt.checkpoints.beginTurn(this.agent.messages.length, text);
    this.controller = new AbortController();
    this.input.setBusy(true);
    const t0 = Date.now();
    try {
      await this.agent.run(content, { signal: this.controller.signal });
    } catch (e) {
      rt.spinner.stop();
      if (e.name === 'AbortError') ui.hint('Interrumpido. ¿Qué hago ahora?');
      else this.showError(e);
    } finally {
      rt.spinner.stop();
      this.input.setBusy(false);
      this.controller = null;
      this.session.model = rt.settings.model;
      this.session.save();
      if (rt.settings.notifications && Date.now() - t0 > 15000) process.stdout.write('\x07');
    }
    const secs = Date.now() - t0;
    if (secs > 20000) ui.hint(`(${formatDuration(secs)})`);
  }

  abort() {
    if (this.controller) { this.controller.abort(); this.runtime.spinner.stop(); }
  }

  expand() {
    const last = this.runtime.lastToolOutput;
    if (!last) return;
    this.runtime.spinner.stop();
    ui.ensureNewline();
    ui.println(c.dim(`── salida completa de ${last.name} ──`));
    ui.println(c.muted(last.content));
    ui.println(c.dim('──'));
  }

  ctrlC() {
    if (Date.now() - this.lastCtrlC < 2000) { this.exit(); return; }
    this.lastCtrlC = Date.now();
    this.statusOverride = 'Pulsa ctrl+c otra vez para salir';
    this.input.refreshBelow();
    setTimeout(() => { this.statusOverride = null; if (this.input.state === 'prompt') this.input.refreshBelow(); }, 2000);
  }

  newSession() {
    this.session.save();
    this.session = new Session({ cwd: this.runtime.cwd, model: this.runtime.settings.model });
    this.runtime.sessionId = this.session.id;
    this.agent = new Agent(this.runtime, { messages: this.session.messages });
    this.runtime.todos = [];
    this.runtime.checkpoints = new (this.runtime.checkpoints.constructor)();
  }

  resume(id) {
    const s = Session.load(id);
    if (!s) return ui.warn('No encontré esa conversación.');
    this.session = s;
    this.runtime.sessionId = s.id;
    this.agent = new Agent(this.runtime, { messages: s.messages });
    ui.success(`Conversación retomada: ${s.title || s.id} (${s.messages.length} mensajes)`);
  }

  showError(e) {
    this.runtime.spinner.stop();
    const [title, cause, action] = describeError(e, this.runtime);
    ui.errorBox(title, cause, action);
    if (process.env.CODICE_DEBUG) ui.println(c.dim(e.stack));
  }

  async exit() {
    if (this.exiting) return;
    this.exiting = true;
    this.session.save();
    this.runtime.mcp.stopAll();
    this.runtime.spinner.stop();
    ui.ensureNewline();
    ui.println(c.dim(`Hasta luego. Retoma esta conversación con: codice --continue`));
    this.input.close();
    setTimeout(() => process.exit(0), 50);
  }
}

export async function startRepl(runtime, { session, initialPrompt = null } = {}) {
  let repl;
  const input = new Input({
    historyFile: path.join(HOME, 'history'),
    getCommands: () => repl?.commandList() || [],
    getStatus: () => repl?.status() || '',
    onModeCycle: () => runtime.cycleMode(),
    onInterrupt: () => repl?.abort(),
    onExpand: () => repl?.expand(),
    onExit: () => repl?.ctrlC(),
  });
  input.start();
  runtime.ui = createUI({ input, spinner: runtime.spinner });
  repl = new Repl(runtime, input, session);
  runtime.sessionId = session.id;
  const start = await runtime.hook('SessionStart', { source: session.messages.length ? 'resume' : 'startup' });
  if (start.context) repl.pendingContext += `\n<session-context>\n${start.context}\n</session-context>`;
  await repl.welcome();
  if (initialPrompt) await repl.handle(initialPrompt);
  await repl.loop();
}
