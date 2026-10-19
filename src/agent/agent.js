// Bucle del agente: llama al modelo, ejecuta herramientas y repite hasta terminar.
import { TagSplitter, stripThinking } from '../llm/stream.js';
import { toPromptMessages, parseTextToolCalls } from '../llm/textTools.js';
import { toolSpec, validateArgs, parseToolArgs } from '../tools/index.js';
import { buildSystemPrompt } from './prompt.js';
import { estimateContext, summarize, keepFromIndex } from './compact.js';
import { truncateMiddle, randomId, formatTokens } from '../util/fs.js';
import { wildcardMatch } from '../util/glob.js';
import * as ui from '../ui/output.js';
import { L } from '../i18n.js';
import { liveActive } from '../ui/live.js';

const MAX_DEPTH = 2;

// Estado que no debe perderse al compactar: lista de tareas y archivos con los que se trabaja.
function sessionState(runtime) {
  const parts = [];
  if (runtime.todos?.length) parts.push(`Task list:\n${runtime.todos.map((t) => `- [${t.status}] ${t.content}`).join('\n')}`);
  const files = [...(runtime.readFiles || [])].slice(-20);
  if (files.length) parts.push(`Files read or edited in this session (read them again before editing):\n${files.map((f) => `- ${f}`).join('\n')}`);
  return parts.length ? `\n\n${parts.join('\n\n')}` : '';
}

// Resumen sin modelo: los pedidos del usuario y los últimos pasos, por si el modelo no logra resumir.
function fallbackSummary(messages) {
  const asks = messages.filter((m) => m.role === 'user' && typeof m.content === 'string' && !m.content.startsWith('[Summary')).map((m) => `- ${m.content.slice(0, 300)}`);
  const prev = messages.find((m) => typeof m.content === 'string' && m.content.startsWith('[Summary'));
  const last = messages.filter((m) => m.role === 'assistant' && m.content).slice(-2).map((m) => String(m.content).slice(0, 800));
  return [
    prev ? prev.content.replace('[Summary of the previous conversation]\n', '').slice(0, 3000) : '',
    asks.length ? `User requests so far:\n${asks.slice(-10).join('\n')}` : '',
    last.length ? `Latest assistant messages:\n${last.join('\n---\n')}` : '',
  ].filter(Boolean).join('\n\n');
}
const SLOW_TOOLS = new Set(['Bash', 'Task', 'WebFetch', 'WebSearch']);

export function abortError() {
  return Object.assign(new Error(L('Interrumpido por el usuario', 'Interrupted by the user')), { name: 'AbortError' });
}

// ── Vistas: cómo se muestra el trabajo del agente ────────────────
export function mainView(runtime) {
  const spinner = runtime.spinner;
  let md = null, rs = null, queue = '', pump = null;
  const verbs = () => runtime.spinnerVerbs();
  const pick = () => { const v = verbs(); return v[Math.floor(Math.random() * v.length)]; };
  return {
    thinking() { spinner.start(pick()); },
    text(t) {
      if (!md) { spinner.stop(); md = new ui.MarkdownStream(); }
      if (!liveActive()) { md.push(t); return; }
      // revela el texto a ritmo constante: los modelos mandan ráfagas y se vería a saltos
      queue += t;
      if (!pump) {
        pump = setInterval(() => {
          const n = Math.max(2, Math.ceil(queue.length / 8));
          md?.push(queue.slice(0, n));
          queue = queue.slice(n);
          if (!queue) { clearInterval(pump); pump = null; }
        }, 16);
      }
    },
    reasoning(r) {
      if (!runtime.settings.showThinking) return;
      if (!rs) { spinner.stop(); rs = ui.reasoningWriter(); }
      rs.push(r);
    },
    endTurn() {
      if (pump) { clearInterval(pump); pump = null; }
      if (queue && md) md.push(queue);
      queue = '';
      rs?.flush(); md?.flush(); md = null; rs = null; spinner.stop();
    },
    tokens(n) { spinner.addTokens(n); },
    toolStart(name, summary) {
      spinner.stop();
      ui.toolStart(name, summary);
      if (SLOW_TOOLS.has(name) || name.startsWith('mcp__')) spinner.start(name === 'Task' ? L('Subagente trabajando…', 'Subagent working…') : L(`Ejecutando ${name}…`, `Running ${name}…`));
    },
    toolEnd(name, summary, r) { spinner.stop(); ui.toolEnd(name, summary, r); },
    notice(t) { spinner.stop(); ui.warn(t); },
    compacting(auto) { spinner.start(auto ? L('Contexto casi lleno: compactando la conversación…', 'Context almost full: compacting conversation…') : L('Compactando la conversación…', 'Compacting conversation…')); },
    compacted(before, after) {
      spinner.stop();
      ui.success(`${L('Conversación compactada', 'Conversation compacted')} · ${formatTokens(before)} → ${formatTokens(after)} tokens`);
    },
    pause() { spinner.stop(); },
  };
}

export function subView(runtime, label) {
  return {
    thinking() {},
    text() {},
    reasoning() {},
    endTurn() {},
    tokens(n) { runtime.spinner.addTokens(n); },
    toolStart(name, summary) { ui.subStep(label, name, summary); },
    toolEnd(name, summary, r) { if (!r.ok) ui.println(`      ${ui.isScreenReader() ? 'Error: ' : ''}${r.text ? String(r.text).split('\n')[0].slice(0, 160) : ''}`); },
    notice(t) { ui.hint(`    ${label}: ${t}`); },
    compacting() {},
    compacted(before, after) { ui.hint(`    ${label}: ${L('contexto compactado', 'context compacted')} ${formatTokens(before)} → ${formatTokens(after)}`); },
    pause() { runtime.spinner.stop(); },
  };
}

// Se añade a cada resultado de herramienta con error: investigar la causa, corregir y seguir.
const RECOVERY_HINT = '\n\n[This failed. Find the cause (read the error and the relevant file or output), fix it and continue with the task. Try a different approach if the same thing failed before.]';

// ── Recuperación de errores del modelo ───────────────────────────
function isTransient(e) {
  if (e?.engine === 'NO_ENGINE') return false;
  if (e?.network || e?.engine === 'LOAD_FAILED') return true;
  if ([408, 409, 425, 429, 500, 502, 503, 504, 529].includes(e?.status)) return true;
  return /terminated|ECONNRESET|socket hang up|ETIMEDOUT|EPIPE|fetch failed|other side closed|overloaded/i.test(e?.message || '');
}

function isContextOverflow(e) {
  return e?.status === 400 && /context|too long|maximum.*tokens|exceed|n_ctx|prompt is too/i.test(`${e.body || ''} ${e.message || ''}`);
}

function shortError(e) {
  return String(e?.status ? `HTTP ${e.status}` : e?.message || 'error').split('\n')[0].slice(0, 60);
}

function sleepAbortable(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

// Algunos modelos locales escriben la llamada como JSON suelto en vez de usar tool_calls.
function bareJsonCall(content, tools) {
  const t = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  try {
    const j = JSON.parse(t);
    const name = j.name || j.tool;
    const args = j.arguments ?? j.parameters ?? j.input;
    if (name && args && tools.some((x) => x.name === name)) return { id: `call_${randomId()}`, name, arguments: JSON.stringify(args) };
  } catch { /* no es JSON */ }
  return null;
}

export class Agent {
  constructor(runtime, { def = null, messages = [], depth = 0, label = null, view = null, provider = null, model = null } = {}) {
    this.runtime = runtime;
    this.def = def;
    this.messages = messages;
    this.depth = depth;
    this.label = label;
    this.view = view || mainView(runtime);
    this.provider = provider;
    this.model = model;
    this.usage = { input: 0, output: 0 };
  }

  get isSub() { return Boolean(this.def); }

  client() {
    return this.runtime.createClient({ provider: this.provider, model: this.model });
  }

  tools() {
    const rt = this.runtime;
    let tools = rt.allTools();
    const allow = this.def?.tools;
    if (allow?.length) tools = tools.filter((t) => allow.some((p) => wildcardMatch(p, t.name)));
    const deny = this.def?.disallowedTools;
    if (deny?.length) tools = tools.filter((t) => !deny.some((p) => wildcardMatch(p, t.name)));
    if (this.depth >= MAX_DEPTH) tools = tools.filter((t) => t.name !== 'Task');
    if (this.isSub) tools = tools.filter((t) => t.name !== 'AskUser' && t.name !== 'ExitPlanMode');
    else if (rt.permissionMode !== 'plan') tools = tools.filter((t) => t.name !== 'ExitPlanMode');
    if (rt.offline) tools = tools.filter((t) => !t.network);
    if (!Object.keys(rt.skills).length) tools = tools.filter((t) => t.name !== 'Skill');
    return tools;
  }

  async run(input, { signal } = {}) {
    if (input != null) this.messages.push({ role: 'user', content: input });
    const maxTurns = this.runtime.settings.maxTurns || 80;
    let turns = 0;
    let finalText = '';
    let stopRetries = 0;
    // Protección contra bucles (frecuentes en modelos pequeños)
    this.callCounts = new Map();
    this.mutations = 0;
    this.loopHits = 0;
    this.errorStreak = 0;
    while (turns < maxTurns) {
      turns++;
      if (signal?.aborted) throw abortError();
      const tools = this.tools();
      await this.maybeCompact(tools, signal);
      const res = await this.callModel(tools, signal);
      const assistant = { role: 'assistant', content: res.content || '' };
      if (res.toolCalls.length) {
        assistant.tool_calls = res.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments || '{}' } }));
      }
      this.messages.push(assistant);
      finalText = res.content;
      if (res.parseErrors?.length && !res.toolCalls.length) {
        this.messages.push({ role: 'user', content: `Your <tool_call> block was not valid JSON (${res.parseErrors[0]}). Repeat the call with valid JSON: {"name": "...", "arguments": {...}}.` });
        continue;
      }
      if (!res.toolCalls.length) {
        if (!this.isSub && stopRetries < 2) {
          const stop = await this.runtime.hook('Stop', { last_message: finalText });
          if (stop.blocked) { stopRetries++; this.messages.push({ role: 'user', content: stop.reason }); continue; }
        }
        return { text: finalText, turns, tokens: this.usage.input + this.usage.output };
      }
      let results;
      try {
        results = await this.executeCalls(res.toolCalls, tools, signal);
      } catch (e) {
        if (e.name === 'AbortError') {
          for (const r of e.partial || []) this.messages.push({ role: 'tool', tool_call_id: r.id, name: r.name, content: r.content });
          this.fillMissingResults();
        }
        throw e;
      }
      for (const r of results) this.messages.push({ role: 'tool', tool_call_id: r.id, name: r.name, content: r.content });
      if (results.some((r) => r.userDenied) && !this.isSub) return { text: '', turns, tokens: this.usage.input + this.usage.output, stopped: true };
      if (this.loopHits >= 3) {
        const msg = L('Detuve la tarea: el modelo repetía las mismas acciones sin avanzar. Prueba con un modelo más grande o divide la tarea en pasos más pequeños.', 'I stopped the task: the model kept repeating the same actions without progress. Try a larger model or split the task into smaller steps.');
        this.view.notice(msg);
        return { text: msg, turns, tokens: this.usage.input + this.usage.output, stuck: true };
      }
      this.errorStreak = results.every((r) => r.isError) ? this.errorStreak + 1 : 0;
      if (this.errorStreak >= 3) {
        this.errorStreak = 0;
        this.messages.push({ role: 'user', content: 'Several attempts in a row failed. Before trying again: use Read to see the CURRENT content of the relevant files, briefly explain what is wrong, then make one careful change.' });
      }
    }
    return { text: `${finalText}\n\n${L(`(Se alcanzó el límite de ${maxTurns} pasos.)`, `(Reached the limit of ${maxTurns} steps.)`)}`, turns, tokens: this.usage.input + this.usage.output };
  }

  async callModel(tools, signal) {
    const rt = this.runtime;
    const client = this.client();
    let mode = rt.toolModeFor(client.model);
    let transient = 0; // reintentos por fallos pasajeros (red, 429, 5xx, motor reiniciándose)
    let compacted = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const specs = tools.map((t) => toolSpec(t, rt, { lean: rt.isLean() }));
      const system = buildSystemPrompt(rt, { agent: this, tools: specs, toolMode: mode, model: client.model });
      let messages = [{ role: 'system', content: system }, ...this.messages];
      if (mode === 'prompt') messages = toPromptMessages(messages);
      const view = this.view;
      view.thinking();
      let streamed = '';
      const splitter = new TagSplitter({ onText: (t) => view.text(t), onReasoning: (r) => view.reasoning(r) });
      const t0 = Date.now();
      try {
        const r = await client.chat({
          messages,
          tools: mode === 'native' && specs.length ? specs : undefined,
          signal,
          onText: (t) => { streamed += t; splitter.push(t); view.tokens(Math.max(1, Math.round(t.length / 4))); },
          onReasoning: (x) => { view.reasoning(x); view.tokens(Math.max(1, Math.round(x.length / 4))); },
        });
        splitter.flush();
        view.endTurn();
        rt.addUsage(r.usage, client, Date.now() - t0);
        if (r.usage) { this.usage.input += r.usage.input; this.usage.output += r.usage.output; }
        let content = stripThinking(r.content);
        let toolCalls = r.toolCalls || [];
        let parseErrors = [];
        if (content.includes('<tool_call>')) {
          const p = parseTextToolCalls(content);
          if (!toolCalls.length) toolCalls = p.calls;
          parseErrors = p.errors;
          content = p.cleaned;
        } else if (!toolCalls.length) {
          const bare = bareJsonCall(content, tools);
          if (bare) { toolCalls = [bare]; content = ''; }
        }
        for (const tc of toolCalls) tc.id ||= `call_${randomId()}`;
        return { content, toolCalls, parseErrors };
      } catch (e) {
        splitter.flush();
        view.endTurn();
        if (e.name === 'AbortError' || signal?.aborted) {
          this.messages.push({ role: 'assistant', content: `${stripThinking(streamed)}\n[interrupted by the user]`.trim() });
          throw abortError();
        }
        if (e.toolsUnsupported && mode === 'native') {
          rt.setToolMode(client.model, 'prompt');
          mode = 'prompt';
          view.notice(L(`${client.model} no soporta herramientas nativas: uso el modo prompt (<tool_call>).`, `${client.model} does not support native tools: using prompt mode (<tool_call>).`));
          continue;
        }
        // la conversación no cabe en el contexto del modelo: se resume y se reintenta (una vez)
        if (!compacted && isContextOverflow(e) && this.messages.length > 2) {
          compacted = true;
          view.notice(L('La conversación no cabía en el contexto del modelo: la resumo y continúo.', 'The conversation did not fit the model context: summarizing and continuing.'));
          await this.compact({ signal });
          continue;
        }
        // fallos pasajeros: se espera y se reintenta, avisando
        // si el servidor no existe (conexión rechazada) un solo reintento basta: más solo hace esperar
        const maxRetries = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(e?.message || '') ? 1 : 3;
        if (transient < maxRetries && isTransient(e)) {
          transient++;
          const wait = [1000, 3000, 8000][transient - 1];
          view.notice(L(`Falló la conexión con el modelo (${shortError(e)}). Reintento ${transient}/3 en ${wait / 1000} s…`, `The model connection failed (${shortError(e)}). Retry ${transient}/3 in ${wait / 1000} s…`));
          await sleepAbortable(wait, signal);
          if (signal?.aborted) throw abortError();
          continue;
        }
        throw e;
      }
    }
    throw new Error(L('No se pudo obtener respuesta del modelo', 'Could not get a response from the model'));
  }

  async executeCalls(calls, tools, signal) {
    const parallel = calls.length > 1 && calls.every((c) => this.findTool(tools, c.name)?.parallelSafe);
    if (parallel) return Promise.all(calls.map((c) => this.executeOne(c, tools, signal)));
    const out = [];
    for (const call of calls) {
      try {
        out.push(await this.executeOne(call, tools, signal));
      } catch (e) {
        e.partial = out;
        throw e;
      }
    }
    return out;
  }

  // Garantiza que cada tool_call del último mensaje del asistente tenga su resultado.
  fillMissingResults() {
    let idx = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) if (this.messages[i].role === 'assistant') { idx = i; break; }
    const calls = this.messages[idx]?.tool_calls || [];
    const have = new Set(this.messages.slice(idx + 1).filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
    for (const tc of calls) if (!have.has(tc.id)) this.messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: 'Interrupted by the user.' });
  }

  findTool(tools, name) {
    return tools.find((t) => t.name === name) || tools.find((t) => t.name.toLowerCase() === String(name).toLowerCase());
  }

  async executeOne(tc, tools, signal) {
    const rt = this.runtime;
    const base = { id: tc.id, name: tc.name };
    const tool = this.findTool(tools, tc.name);
    if (!tool) return { ...base, content: `Error: tool "${tc.name}" does not exist. Available: ${tools.map((t) => t.name).join(', ')}` };
    let args;
    try { args = parseToolArgs(tc.arguments); } catch (e) { return { ...base, content: `Error: invalid JSON arguments (${e.message}). Retry with valid JSON.` }; }
    const invalid = validateArgs(tool, args);
    if (invalid) return { ...base, content: `Error: ${invalid}` };
    const deferred = [];
    const ctx = { runtime: rt, cwd: rt.cwd, signal, agent: this, depth: this.depth, agentLabel: this.label, ui: rt.ui.forTool(deferred) };
    let summary = '';
    try { summary = tool.summary ? String(tool.summary(args, ctx) ?? '') : ''; } catch { summary = ''; }
    // Misma llamada repetida: las ediciones idénticas cuentan siempre; el resto solo si nada cambió entre medias.
    const sig = `${tool.name}:${JSON.stringify(args)}${tool.edits ? '' : `#${this.mutations || 0}`}`;
    const seen = (this.callCounts?.get(sig) || 0) + 1;
    this.callCounts?.set(sig, seen);
    if (seen >= 3 && !tool.parallelSafe && tool.name !== 'TodoWrite') {
      this.loopHits = (this.loopHits || 0) + 1;
      this.view.toolStart(tool.name, summary);
      this.view.toolEnd(tool.name, summary, { ok: false, text: L('Llamada repetida bloqueada', 'Repeated call blocked') });
      return { ...base, isError: true, content: `You already made this exact ${tool.name} call ${seen - 1} times. Do NOT repeat it. Use Read to look at the CURRENT content of the file, think about why it did not work, and try a different approach.` };
    }
    this.view.toolStart(tool.name, summary);
    const perm = await rt.permissions.check(tool, args, ctx);
    if (!perm.allowed) {
      this.view.toolEnd(tool.name, summary, { ok: false, text: perm.userDenied ? L('Rechazado por el usuario', 'Rejected by the user') : perm.reason });
      return { ...base, content: `Permission denied: ${perm.reason}`, userDenied: perm.userDenied };
    }
    const pre = await rt.hook('PreToolUse', { tool_name: tool.name, tool_input: args }, tool.name);
    if (pre.blocked) {
      this.view.toolEnd(tool.name, summary, { ok: false, text: L(`Bloqueado por hook: ${pre.reason}`, `Blocked by hook: ${pre.reason}`) });
      return { ...base, content: `Blocked by a hook: ${pre.reason}` };
    }
    try {
      let r = await tool.run(args, ctx);
      if (typeof r === 'string') r = { content: r };
      let content = truncateMiddle(String(r.content ?? ''), 40000);
      const post = await rt.hook('PostToolUse', { tool_name: tool.name, tool_input: args, tool_response: content.slice(0, 10000) }, tool.name);
      if (post.blocked) content += `\n\n[Hook PostToolUse]: ${post.reason}`;
      if (post.context) content += `\n\n${post.context}`;
      const display = r.display ?? content.split('\n')[0].slice(0, 160);
      this.view.toolEnd(tool.name, summary, { ok: !r.isError, text: display });
      for (const f of deferred) f();
      rt.lastToolOutput = { name: tool.name, content: String(r.content ?? '') };
      if (tool.edits && !r.isError) this.mutations = (this.mutations || 0) + 1;
      if (r.isError) content += RECOVERY_HINT;
      return { ...base, content: content || '(no output)', isError: Boolean(r.isError) };
    } catch (e) {
      if (e.name === 'AbortError' || signal?.aborted) {
        this.view.toolEnd(tool.name, summary, { ok: false, text: L('Interrumpido', 'Interrupted') });
        throw abortError();
      }
      this.view.toolEnd(tool.name, summary, { ok: false, text: e.message });
      return { ...base, content: `Error: ${e.message}${RECOVERY_HINT}`, isError: true };
    }
  }

  // ── Contexto ───────────────────────────────────────────────────
  contextUsage(tools = this.tools()) {
    const specs = tools.map((t) => toolSpec(t, this.runtime));
    const system = buildSystemPrompt(this.runtime, { agent: this, tools: specs, toolMode: 'prompt', model: this.model || this.runtime.settings.model });
    const used = estimateContext(system, this.messages);
    return { used, max: this.runtime.contextWindow(), system: estimateContext(system, []) };
  }

  async maybeCompact(tools, signal) {
    const ratio = Number(this.runtime.settings.autoCompact) || 0;
    if (!ratio || this.messages.length < 4) return;
    const { used, max } = this.contextUsage(tools);
    if (used < max * ratio) return;
    await this.compact({ signal, auto: true });
  }

  // Resume la conversación y la sustituye por el resumen, el estado actual (tareas, archivos) y lo más reciente.
  async compact({ instructions = '', signal, auto = false } = {}) {
    if (this.messages.length < 2) return null;
    const window = this.runtime.contextWindow();
    let cut = keepFromIndex(this.messages);
    // si lo último es muy grande (una sola tarea larga), se resume todo
    const tail = this.messages.slice(cut);
    if (cut === 0 || estimateContext('', tail) > window * 0.5) cut = this.messages.length;
    const head = this.messages.slice(0, cut);
    if (!head.length) return null;
    const before = estimateContext('', this.messages);
    this.view.compacting?.(auto);
    let summary;
    try {
      summary = await summarize(this.client(), head, { instructions, signal, budget: Math.floor(window * 0.6) });
    } catch (e) {
      if (e.name === 'AbortError' || signal?.aborted) { this.view.pause(); throw e; }
      // el modelo no pudo resumir: se conserva lo esencial sin él para poder seguir
      summary = fallbackSummary(head);
    }
    if (!summary?.trim()) summary = fallbackSummary(head);
    const kept = this.messages.slice(cut);
    this.messages.length = 0;
    this.messages.push(
      { role: 'user', content: `[Summary of the previous conversation]\n${summary}${sessionState(this.runtime)}` },
      { role: 'assistant', content: 'Understood. I have the context and will continue from there.' },
      ...kept,
    );
    if (!kept.length && head.at(-1)?.role !== 'assistant') {
      this.messages.push({ role: 'user', content: 'Continue with the pending task.' });
    }
    const after = estimateContext('', this.messages);
    this.lastCompaction = { before, after, at: Date.now(), auto };
    this.view.compacted?.(before, after);
    return summary;
  }
}
