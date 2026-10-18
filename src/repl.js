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
import { L } from './i18n.js';
import { runOnboarding } from './onboarding.js';

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
  const p = runtime.providerInfo?.();
  const name = p?.label || provider;
  if (e instanceof LLMError) {
    if (e.network) {
      if (p?.type === 'ollama') return [L('No encuentro Ollama en esta PC', 'Ollama is not running on this computer'), e.message, L('Instálalo desde ollama.com (o ábrelo si ya lo tienes) y descarga un modelo con “ollama pull qwen2.5-coder:3b”. También puedes elegir otra forma de conectarte con /setup.', 'Install it from ollama.com (or open it if you have it) and download a model with “ollama pull qwen2.5-coder:3b”. You can also choose another way to connect with /setup.')];
      if (p?.type === 'codice') return [L(`No pude conectar con tu PC remota (${name})`, `Could not reach your remote PC (${name})`), e.message, L('Revisa que “codice serve” siga abierto en esa PC y que estén en la misma red (o en Tailscale). Usa /setup para cambiar de conexión.', 'Check that “codice serve” is still running on that PC and that you are on the same network (or Tailscale). Use /setup to switch connection.')];
      return [L(`No pude conectar con ${name}`, `Could not connect to ${name}`), e.message, L('Revisa que el servidor esté encendido o elige otra conexión con /setup.', 'Check that the server is running or choose another connection with /setup.')];
    }
    if (e.status === 401 || e.status === 403) return [L(`${name} rechazó la API key`, `${name} rejected the API key`), `HTTP ${e.status}`, L('Vuelve a configurarla con /setup.', 'Set it up again with /setup.')];
    if (e.status === 404) return [L(`El modelo “${runtime.settings.model}” no está disponible`, `Model “${runtime.settings.model}” is not available`), `HTTP 404`, p?.type === 'ollama' ? L(`Descárgalo con “ollama pull ${runtime.settings.model}” o elige otro con /models.`, `Download it with “ollama pull ${runtime.settings.model}” or pick another with /models.`) : L('Elige otro modelo con /models.', 'Pick another model with /models.')];
    if (e.status === 429) return [L(`${name} limitó las peticiones`, `${name} is rate limiting requests`), `HTTP 429`, L('Espera un momento y vuelve a intentarlo, o cambia de modelo con /models.', 'Wait a moment and try again, or switch models with /models.')];
    if (e.status === 400 && /context|token/i.test(e.body)) return [L('La conversación no cabe en el contexto del modelo', 'The conversation does not fit the model context'), 'HTTP 400', L('Usa /compact para resumirla o aumenta contextWindow en /config.', 'Use /compact to summarize it or raise contextWindow in /config.')];
  }
  return [L('Ocurrió un error', 'Something went wrong'), e.message, null];
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
    ui.warn(runtime.settings.provider === 'ollama' ? L('Ollama no tiene modelos. Descarga uno: ollama pull qwen2.5-coder:3b', 'Ollama has no models. Download one: ollama pull qwen2.5-coder:3b') : L('El proveedor no tiene modelos disponibles.', 'The provider has no models available.'));
    return false;
  }
  let pick = models[0].id;
  const coder = models.find((m) => /coder|code/i.test(m.id));
  if (models.length > 1 && input) {
    pick = await select(input, { title: L('Elige un modelo para empezar', 'Choose a model to start'), options: models.map((m) => ({ label: m.id, value: m.id, hint: m.size ? `${(m.size / 1e9).toFixed(1)} GB` : '' })), initial: coder ? models.indexOf(coder) : 0 });
    if (!pick) return false;
  } else if (coder) pick = coder.id;
  runtime.save('model', pick);
  ui.success(L(`Modelo: ${pick}`, `Model: ${pick}`));
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
    for (const [name, cmd] of Object.entries(BUILTIN_COMMANDS)) out.push({ name: `/${name}`, description: typeof cmd.description === 'function' ? cmd.description() : cmd.description, source: 'integrado', label: L('integrado', 'built-in') });
    for (const cmd of Object.values(rt.commands)) out.push({ name: `/${cmd.name}`, description: cmd.description, source: cmd.source.startsWith('plugin') ? cmd.source : L('personalizado', 'custom') });
    for (const s of Object.values(rt.skills)) out.push({ name: `/${s.name}`, description: s.description, source: 'skill' });
    for (const p of rt.mcp.prompts()) out.push({ name: `/${p.name}`, description: p.description, source: 'MCP' });
    return out;
  }

  status() {
    return this.statusOverride ? `  ${c.warning(this.statusOverride)}` : this.runtime.statusLine(this.agent);
  }

  async welcome() {
    const rt = this.runtime;
    if (!rt.settings.onboarded && this.input.tty) await runOnboarding(rt, this.input);
    ui.banner({
      version: VERSION,
      model: rt.settings.model,
      provider: rt.providerInfo()?.label || rt.settings.provider,
      cwd: rt.cwd,
      memory: rt.memory.map((m) => m.name),
      mascot: rt.mascot(),
    });
    const failed = rt.mcp.status().filter((x) => x.status !== 'conectado');
    if (failed.length) ui.warn(L(`${failed.length} servidor(es) MCP no conectaron. Revisa /mcp.`, `${failed.length} MCP server(s) failed to connect. See /mcp.`));
    if (rt.themeWarnings?.length) ui.warn(L('Tu tema tiene colores con poco contraste. Revisa /accessibility.', 'Your theme has low-contrast colors. See /accessibility.'));
    if (this.session.messages.length) ui.hint(L(`Conversación retomada (${this.session.messages.length} mensajes).`, `Conversation resumed (${this.session.messages.length} messages).`));
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
      return ui.success(L(`Guardado en memoria (${relPath(f, this.runtime.cwd)})`, `Saved to memory (${relPath(f, this.runtime.cwd)})`));
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
    ui.warn(L(`Comando desconocido: /${rawName}. Escribe /help para ver la lista.`, `Unknown command: /${rawName}. Type /help to see the list.`));
  }

  async shell(cmd) {
    if (!cmd) return;
    const r = await runShell(cmd, { cwd: this.runtime.cwd, timeout: 300000 });
    const outText = r.output.replace(/\r\n/g, '\n').trimEnd();
    const lines = outText.split('\n');
    for (const l of lines.slice(0, 40)) ui.println(c.muted(l));
    if (lines.length > 40) ui.hint(L(`… ${lines.length - 40} líneas más (se añadieron completas al contexto)`, `… ${lines.length - 40} more lines (added in full to the context)`));
    if (r.code !== 0) ui.println(c.error(L(`código de salida ${r.code}`, `exit code ${r.code}`)));
    this.pendingContext += `\n<bash-input>${cmd}</bash-input>\n<bash-output>\n${truncateMiddle(outText, 20000)}\n</bash-output>`;
  }

  async runPrompt(text, { display = null } = {}) {
    const rt = this.runtime;
    if (!rt.settings.model) {
      if (this.input.tty) { ui.hint(L('Primero elige cómo conectarte a un modelo.', 'First choose how to connect to a model.')); await runOnboarding(rt, this.input); }
      if (!rt.settings.model && !(await ensureModel(rt, { input: this.input }))) return;
    }
    const { text: withFiles, attached } = expandMentions(text, rt.cwd);
    if (attached.length) ui.hint(L(`Adjuntado: ${attached.join(', ')}`, `Attached: ${attached.join(', ')}`));
    if (display) ui.println(c.dim(display));
    const hook = await rt.hook('UserPromptSubmit', { prompt: text });
    if (hook.blocked) return ui.warn(L(`Bloqueado por un hook: ${hook.reason}`, `Blocked by a hook: ${hook.reason}`));
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
      if (e.name === 'AbortError') ui.hint(L('Interrumpido. ¿Qué hago ahora?', 'Interrupted. What should I do instead?'));
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
    ui.println(c.dim(L(`── salida completa de ${last.name} ──`, `── full output of ${last.name} ──`)));
    ui.println(c.muted(last.content));
    ui.println(c.dim('──'));
  }

  ctrlC() {
    if (Date.now() - this.lastCtrlC < 2000) { this.exit(); return; }
    this.lastCtrlC = Date.now();
    this.statusOverride = L('Pulsa ctrl+c otra vez para salir', 'Press ctrl+c again to exit');
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
    if (!s) return ui.warn(L('No encontré esa conversación.', 'Conversation not found.'));
    this.session = s;
    this.runtime.sessionId = s.id;
    this.agent = new Agent(this.runtime, { messages: s.messages });
    ui.success(L(`Conversación retomada: ${s.title || s.id} (${s.messages.length} mensajes)`, `Conversation resumed: ${s.title || s.id} (${s.messages.length} messages)`));
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
    ui.println(c.dim(L('Hasta luego. Retoma esta conversación con: codice --continue', 'Bye. Resume this conversation with: codice --continue')));
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
