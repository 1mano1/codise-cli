// Cliente para la API nativa de Ollama (/api/chat): permite fijar num_ctx y soporta tools y "thinking".
import { ndjson } from './stream.js';
import { LLMError, looksLikeToolsUnsupported, safeFetch } from './openai.js';
import { L } from '../i18n.js';
import { postJSON } from './compress.js';

function safeParse(s) {
  if (s && typeof s === 'object') return s;
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

export class OllamaClient {
  constructor({ baseUrl, model, temperature = 0.2, contextWindow = 16384, maxTokens = 0, headers = {}, apiKey, label = 'Ollama', gzip = false, thinking, sampling = null }) {
    this.gzip = gzip;
    this.thinking = thinking;
    this.sampling = sampling;
    this.baseUrl = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    this.model = model;
    this.temperature = temperature;
    this.contextWindow = contextWindow;
    this.maxTokens = maxTokens;
    this.extraHeaders = headers;
    this.apiKey = apiKey;
    this.label = label;
    this.kind = 'ollama';
  }

  headers() {
    const h = { 'Content-Type': 'application/json', ...this.extraHeaders };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async listModels() {
    const res = await safeFetch(`${this.baseUrl}/api/tags`, { headers: this.headers(), signal: AbortSignal.timeout(8000) }, this.label);
    if (!res.ok) throw new LLMError(L(`HTTP ${res.status} al listar modelos`, `HTTP ${res.status} while listing models`), { status: res.status });
    const j = await res.json();
    return (j.models || []).map((m) => ({ id: m.name, size: m.size || null, details: m.details || null }));
  }

  async showModel(name) {
    try {
      const res = await safeFetch(`${this.baseUrl}/api/show`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ model: name || this.model }), signal: AbortSignal.timeout(8000) }, this.label);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  toOllama(messages) {
    return messages.map((m) => {
      if (m.role === 'assistant' && m.tool_calls?.length) {
        return { role: 'assistant', content: m.content || '', tool_calls: m.tool_calls.map((tc) => ({ function: { name: tc.function.name, arguments: safeParse(tc.function.arguments) } })) };
      }
      if (m.role === 'tool') return { role: 'tool', content: m.content, tool_name: m.name };
      return { role: m.role, content: m.content ?? '' };
    });
  }

  async chat({ messages, tools, signal, onText, onReasoning, maxTokens }) {
    const options = { temperature: this.temperature, num_ctx: this.contextWindow, ...(this.sampling || {}) };
    const mt = maxTokens || this.maxTokens;
    if (mt) options.num_predict = mt;
    const body = { model: this.model, messages: this.toOllama(messages), stream: true, options };
    if (this.thinking === false) body.think = false;
    if (tools?.length) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    const res = await postJSON(`${this.baseUrl}/api/chat`, { headers: this.headers(), body, signal, gzip: this.gzip }, this.label);
    if (!res.ok) {
      const text = await res.text();
      throw new LLMError(`HTTP ${res.status}: ${text.slice(0, 400)}`, { status: res.status, body: text, toolsUnsupported: Boolean(tools?.length) && looksLikeToolsUnsupported(res.status, text) });
    }
    let content = '', reasoning = '', usage = null;
    const calls = [];
    for await (const j of ndjson(res.body)) {
      if (j.error) throw new LLMError(j.error, { status: 500 });
      const msg = j.message || {};
      if (msg.thinking) { reasoning += msg.thinking; onReasoning?.(msg.thinking); }
      if (msg.content) { content += msg.content; onText?.(msg.content); }
      for (const tc of msg.tool_calls || []) {
        calls.push({ id: `call_${Math.random().toString(36).slice(2, 10)}`, name: tc.function?.name, arguments: JSON.stringify(tc.function?.arguments ?? {}) });
      }
      if (j.done) usage = { input: j.prompt_eval_count || 0, output: j.eval_count || 0, evalDurationNs: j.eval_duration || 0 };
    }
    return { content, reasoning, toolCalls: calls.filter((x) => x.name), usage, finish: 'stop' };
  }
}
