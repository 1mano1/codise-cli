// Cliente para APIs compatibles con OpenAI (LM Studio, llama.cpp, vLLM, Jan, OpenRouter, OpenAI, Groq…).
import { sse } from './stream.js';
import { L } from '../i18n.js';
import { parseRateLimits } from '../usage.js';
import { postJSON } from './compress.js';

export class LLMError extends Error {
  constructor(message, { status = 0, body = '', network = false, toolsUnsupported = false } = {}) {
    super(message);
    this.status = status;
    this.body = body;
    this.network = network;
    this.toolsUnsupported = toolsUnsupported;
  }
}

export function looksLikeToolsUnsupported(status, text) {
  return status >= 400 && status < 500 && /(does not support tools|tool[s_ ]*(?:use|calling|choice)?\s*(?:is\s*)?not\s*supported|unsupported.*tool|function calling)/i.test(text);
}

export async function safeFetch(url, init, label) {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    const cause = e.cause?.code || e.cause?.message || e.message;
    throw new LLMError(L(`No se pudo conectar con ${label} (${cause})`, `Could not connect to ${label} (${cause})`), { network: true });
  }
}

export class OpenAIClient {
  constructor({ baseUrl, apiKey, model, temperature = 0.2, maxTokens = 0, headers = {}, label = 'el proveedor', gzip = false, thinking }) {
    this.gzip = gzip;
    this.thinking = thinking;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.model = model;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.extraHeaders = headers;
    this.label = label;
    this.kind = 'openai';
  }

  headers() {
    const h = { 'Content-Type': 'application/json', ...this.extraHeaders };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async listModels() {
    const res = await safeFetch(`${this.baseUrl}/models`, { headers: this.headers(), signal: AbortSignal.timeout(8000) }, this.label);
    if (!res.ok) throw new LLMError(L(`HTTP ${res.status} al listar modelos`, `HTTP ${res.status} while listing models`), { status: res.status, body: await res.text() });
    const j = await res.json();
    return (j.data || j.models || []).map((m) => ({ id: m.id || m.name, size: m.size || null }));
  }

  async chat({ messages, tools, signal, onText, onReasoning, onToolCall, maxTokens }) {
    const body = { model: this.model, messages, stream: true, temperature: this.temperature, stream_options: { include_usage: true } };
    if (tools?.length) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    const mt = maxTokens || this.maxTokens;
    if (mt) body.max_tokens = mt;
    if (/openrouter\.ai/.test(this.baseUrl)) body.usage = { include: true }; // OpenRouter devuelve el costo real
    // llama.cpp, vLLM y LM Studio: apaga el razonamiento de Qwen3 y similares (plantilla de chat)
    if (this.thinking === false) body.chat_template_kwargs = { enable_thinking: false };
    const res = await postJSON(`${this.baseUrl}/chat/completions`, { headers: this.headers(), body, signal, gzip: this.gzip }, this.label);
    this.lastRateLimits = parseRateLimits(res.headers) || this.lastRateLimits;
    if (!res.ok) {
      const text = await res.text();
      // algunos servidores no aceptan stream_options
      if (res.status === 400 && /stream_options/i.test(text)) {
        delete body.stream_options;
        return this.chatWithBody(body, { signal, onText, onReasoning, onToolCall });
      }
      throw new LLMError(`HTTP ${res.status}: ${text.slice(0, 400)}`, { status: res.status, body: text, toolsUnsupported: Boolean(tools?.length) && looksLikeToolsUnsupported(res.status, text) });
    }
    return this.readStream(res, { onText, onReasoning, onToolCall });
  }

  async chatWithBody(body, { signal, onText, onReasoning, onToolCall }) {
    const res = await postJSON(`${this.baseUrl}/chat/completions`, { headers: this.headers(), body, signal, gzip: this.gzip }, this.label);
    if (!res.ok) {
      const text = await res.text();
      throw new LLMError(`HTTP ${res.status}: ${text.slice(0, 400)}`, { status: res.status, body: text, toolsUnsupported: Boolean(body.tools) && looksLikeToolsUnsupported(res.status, text) });
    }
    return this.readStream(res, { onText, onReasoning, onToolCall });
  }

  async readStream(res, { onText, onReasoning, onToolCall }) {
    let content = '', reasoning = '', usage = null, finish = null;
    const calls = [];
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      // servidor sin streaming
      const j = await res.json();
      const msg = j.choices?.[0]?.message || {};
      content = msg.content || '';
      if (content) onText?.(content);
      for (const tc of msg.tool_calls || []) calls.push({ id: tc.id, name: tc.function?.name, arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {}) });
      usage = j.usage;
      finish = j.choices?.[0]?.finish_reason;
    } else {
      for await (const data of sse(res.body)) {
        if (data === '[DONE]') break;
        let j;
        try { j = JSON.parse(data); } catch { continue; }
        if (j.error) throw new LLMError(j.error.message || JSON.stringify(j.error), { status: 500 });
        if (j.usage) usage = j.usage;
        const ch = j.choices?.[0];
        if (!ch) continue;
        const d = ch.delta || ch.message || {};
        const r = d.reasoning_content ?? d.reasoning;
        if (r) { reasoning += r; onReasoning?.(r); }
        if (d.content) { content += d.content; onText?.(d.content); }
        for (const tc of d.tool_calls || []) {
          const i = tc.index ?? (tc.id ? calls.length : Math.max(0, calls.length - 1));
          calls[i] ??= { id: '', name: '', arguments: '' };
          if (tc.id) calls[i].id = tc.id;
          if (tc.function?.name && !calls[i].name) calls[i].name = tc.function.name;
          const chunk = tc.function?.arguments ? (typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments)) : '';
          calls[i].arguments += chunk;
          onToolCall?.(calls[i].name, chunk);
        }
        if (ch.finish_reason) finish = ch.finish_reason;
      }
    }
    return {
      content,
      reasoning,
      toolCalls: calls.filter((x) => x && x.name),
      usage: usage ? { input: usage.prompt_tokens || 0, output: usage.completion_tokens || 0, cached: usage.prompt_tokens_details?.cached_tokens || 0, cost: typeof usage.cost === 'number' ? usage.cost : undefined } : null,
      finish,
    };
  }
}
