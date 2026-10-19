// Fábrica de clientes: local (Ollama/OpenAI-compatible), nube y PC remota (codice serve), con respaldo.
import { OpenAIClient, LLMError, safeFetch } from './openai.js';
import { OllamaClient } from './ollama.js';
import { resolveProvider, listProviderNames } from '../config.js';
import { L } from '../i18n.js';
import { scanModels, resolveModelFile } from '../local/models.js';
import { localEngine } from '../local/engine.js';
import { wantsGzip } from './compress.js';
import { samplingFor } from './sampling.js';

export { LLMError };

function baseOpts(settings, provider, model) {
  return {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model,
    temperature: settings.temperature,
    contextWindow: provider.contextWindow || settings.contextWindow,
    maxTokens: settings.maxOutputTokens,
    headers: provider.headers || {},
    label: provider.label || provider.name,
    gzip: wantsGzip(settings, provider),
    // thinking: false apaga el razonamiento en modelos que lo permiten (Qwen3, DeepSeek-R1…). Solo en servidores
    // propios: las APIs en la nube rechazan parámetros desconocidos.
    thinking: provider.cloud ? undefined : (provider.thinking ?? settings.thinking),
    // muestreo recomendado por familia (p. ej. Qwen3: temperatura 0.6, top_k 20, presence_penalty 1)
    sampling: samplingFor(model, { ...settings, thinking: provider.thinking ?? settings.thinking }, provider),
  };
}

// Cliente para una PC remota con `codice serve`: consulta /codice/info y usa el backend que exponga.
export class RemoteClient {
  constructor(opts) {
    this.opts = opts;
    this.model = opts.model;
    this.kind = 'codice';
    this.inner = null;
    this.label = opts.label;
  }

  async info() {
    const res = await safeFetch(`${this.opts.baseUrl.replace(/\/+$/, '')}/codice/info`, {
      headers: { Authorization: `Bearer ${this.opts.apiKey || ''}` },
      signal: AbortSignal.timeout(8000),
    }, this.opts.label);
    if (res.status === 401) throw new LLMError(L('Token inválido para la PC remota (revisa --token)', 'Invalid token for the remote PC (check --token)'), { status: 401 });
    if (!res.ok) throw new LLMError(L(`La PC remota respondió HTTP ${res.status}`, `The remote PC replied HTTP ${res.status}`), { status: res.status });
    return res.json();
  }

  async resolve() {
    if (this.inner) return this.inner;
    const info = await this.info();
    const base = this.opts.baseUrl.replace(/\/+$/, '');
    const common = { ...this.opts, model: this.model };
    if (info.backend === 'ollama') this.inner = new OllamaClient({ ...common, baseUrl: `${base}/ollama` });
    else this.inner = new OpenAIClient({ ...common, baseUrl: `${base}/openai/v1` });
    this.backend = info.backend;
    return this.inner;
  }

  async listModels() {
    return (await this.resolve()).listModels();
  }

  async chat(args) {
    const c = await this.resolve();
    c.model = this.model;
    return c.chat(args);
  }
}

// Modelos GGUF en disco: Códice arranca llama-server con el modelo elegido y le habla por la API OpenAI.
export class LocalClient {
  constructor(opts, settings) {
    this.opts = opts;
    this.settings = settings;
    this.model = opts.model;
    this.kind = 'local';
    this.label = opts.label;
  }

  async listModels() {
    return scanModels(this.settings).map((m) => ({ id: m.id, size: m.size, source: m.source }));
  }

  async chat(args) {
    const m = resolveModelFile(this.settings, this.model);
    if (!m) throw new LLMError(L(`No encuentro el modelo "${this.model}" en tus carpetas de modelos`, `Model "${this.model}" not found in your model folders`), { status: 404 });
    let url;
    try {
      url = await localEngine.ensure(m, this.settings);
    } catch (e) {
      throw Object.assign(new LLMError(e.message, { status: 0 }), { engine: e.code || 'LOAD_FAILED' });
    }
    const client = new OpenAIClient({ ...this.opts, baseUrl: `${url}/v1`, model: m.id, label: m.id });
    return client.chat(args);
  }
}

export function createSingleClient(settings, providerName, model) {
  const provider = resolveProvider(settings, providerName);
  if (!provider) throw new LLMError(L(`Proveedor desconocido: ${providerName}. Usa /setup o /provider.`, `Unknown provider: ${providerName}. Use /setup or /provider.`));
  const o = baseOpts(settings, provider, model);
  let client;
  if (provider.type === 'local') client = new LocalClient(o, settings);
  else if (provider.type === 'ollama') client = new OllamaClient(o);
  else if (provider.type === 'codice') client = new RemoteClient(o);
  else client = new OpenAIClient(o);
  client.providerName = providerName;
  client.provider = provider;
  return client;
}

// "proveedor:modelo" → { provider, model }. El modelo puede contener ":" (p. ej. qwen2.5:7b),
// así que solo se separa si el prefijo es un proveedor conocido.
export function parseTarget(spec, settings) {
  const i = spec.indexOf(':');
  if (i > 0) {
    const p = spec.slice(0, i);
    if (listProviderNames(settings).includes(p)) return { provider: p, model: spec.slice(i + 1) };
  }
  return { provider: settings.provider, model: spec };
}

// Prueba proveedores en orden si hay errores de red o 5xx. No reintenta en errores 4xx.
export class FallbackClient {
  constructor(settings, chain, { onFallback } = {}) {
    this.settings = settings;
    this.chain = chain; // [{provider, model}]
    this.onFallback = onFallback;
    this.index = 0;
    this.current = createSingleClient(settings, chain[0].provider, chain[0].model);
  }

  get model() { return this.current.model; }
  get providerName() { return this.current.providerName; }
  get kind() { return this.current.kind; }
  get provider() { return this.current.provider; }

  async listModels() {
    return this.current.listModels();
  }

  async chat(args) {
    for (;;) {
      try {
        return await this.current.chat(args);
      } catch (e) {
        const retryable = e instanceof LLMError && (e.network || e.status >= 500);
        if (!retryable || this.index >= this.chain.length - 1 || args.signal?.aborted) throw e;
        this.index++;
        const next = this.chain[this.index];
        this.current = createSingleClient(this.settings, next.provider, next.model);
        this.onFallback?.(next, e);
      }
    }
  }
}

export function createClient(settings, { provider, model, onFallback } = {}) {
  const chain = [{ provider: provider || settings.provider, model: model || settings.model }];
  for (const spec of settings.fallback || []) chain.push(parseTarget(spec, settings));
  if (chain.length === 1) return createSingleClient(settings, chain[0].provider, chain[0].model);
  return new FallbackClient(settings, chain, { onFallback });
}
