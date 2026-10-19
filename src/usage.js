// Consumo: histórico local por día/proveedor/modelo, saldo de los proveedores que lo exponen por API,
// límites de velocidad que devuelven las respuestas y costo estimado con precios configurables.
import path from 'node:path';
import { HOME } from './config.js';
import { readJSON, writeJSON } from './util/fs.js';

const FILE = () => path.join(HOME, 'usage.json');
const KEEP_DAYS = 400;

const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

// Precio estimado: settings.pricing = { "modelo" | "proveedor:modelo": { input: USD por 1M, output: USD por 1M } }
export function estimateCost(pricing, provider, model, usage) {
  const p = pricing?.[`${provider}:${model}`] || pricing?.[model];
  if (!p) return null;
  const cachedPrice = p.cached ?? p.input;
  const fresh = Math.max(0, (usage.input || 0) - (usage.cached || 0));
  return (fresh * (p.input || 0) + (usage.cached || 0) * (cachedPrice || 0) + (usage.output || 0) * (p.output || 0)) / 1e6;
}

export function recordUsage({ provider, model, usage, cost = null, kind = 'local' }) {
  if (!usage) return;
  const data = readJSON(FILE(), { days: {} });
  const d = (data.days[day()] ||= {});
  const key = `${provider}:${model}`;
  const e = (d[key] ||= { requests: 0, input: 0, output: 0, cached: 0, cost: 0, kind });
  e.requests++;
  e.input += usage.input || 0;
  e.output += usage.output || 0;
  e.cached += usage.cached || 0;
  if (cost != null) e.cost += cost;
  // conserva los últimos KEEP_DAYS días
  const days = Object.keys(data.days).sort();
  for (const old of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete data.days[old];
  try { writeJSON(FILE(), data); } catch { /* sin disco: el histórico es opcional */ }
}

// range: 'today' | 'month' | 'all'
export function usageTotals(range = 'today') {
  const data = readJSON(FILE(), { days: {} });
  const today = day();
  const month = today.slice(0, 7);
  const out = {};
  for (const [d, entries] of Object.entries(data.days)) {
    if (range === 'today' && d !== today) continue;
    if (range === 'month' && !d.startsWith(month)) continue;
    for (const [key, e] of Object.entries(entries)) {
      const t = (out[key] ||= { requests: 0, input: 0, output: 0, cached: 0, cost: 0, kind: e.kind });
      for (const k of ['requests', 'input', 'output', 'cached', 'cost']) t[k] += e[k] || 0;
    }
  }
  return out;
}

// Encabezados de límites de velocidad (OpenAI, Groq, OpenRouter, Anthropic…).
export function parseRateLimits(headers) {
  if (!headers) return null;
  const get = (k) => headers.get?.(k) ?? null;
  const out = {};
  const pairs = [
    ['requests', ['x-ratelimit-remaining-requests', 'anthropic-ratelimit-requests-remaining'], ['x-ratelimit-limit-requests', 'anthropic-ratelimit-requests-limit'], ['x-ratelimit-reset-requests', 'anthropic-ratelimit-requests-reset']],
    ['tokens', ['x-ratelimit-remaining-tokens', 'anthropic-ratelimit-tokens-remaining'], ['x-ratelimit-limit-tokens', 'anthropic-ratelimit-tokens-limit'], ['x-ratelimit-reset-tokens', 'anthropic-ratelimit-tokens-reset']],
  ];
  for (const [name, rem, lim, reset] of pairs) {
    const remaining = rem.map(get).find((v) => v != null);
    if (remaining == null) continue;
    out[name] = { remaining: Number(remaining), limit: Number(lim.map(get).find((v) => v != null)) || null, reset: reset.map(get).find((v) => v != null) || null };
  }
  return Object.keys(out).length ? { ...out, at: Date.now() } : null;
}

// Dónde ver la facturación de los proveedores que no exponen saldo por API.
export const BILLING_URLS = {
  anthropic: 'https://console.anthropic.com/settings/billing',
  openai: 'https://platform.openai.com/usage',
  gemini: 'https://aistudio.google.com/usage',
  groq: 'https://console.groq.com/settings/billing',
  openrouter: 'https://openrouter.ai/settings/credits',
  deepseek: 'https://platform.deepseek.com/usage',
};

// Saldo real del proveedor cuando su API lo permite.
export async function providerBalance(provider) {
  if (!provider) return null;
  const auth = provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {};
  const timeout = AbortSignal.timeout(8000);
  try {
    if (provider.name === 'openrouter' || /openrouter\.ai/.test(provider.baseUrl)) {
      const r = await fetch('https://openrouter.ai/api/v1/key', { headers: auth, signal: timeout });
      if (!r.ok) return { error: `HTTP ${r.status}` };
      const d = (await r.json()).data || {};
      return { kind: 'credits', currency: 'USD', used: d.usage ?? null, limit: d.limit ?? null, remaining: d.limit_remaining ?? null, freeTier: Boolean(d.is_free_tier) };
    }
    if (provider.name === 'deepseek' || /deepseek\.com/.test(provider.baseUrl)) {
      const r = await fetch('https://api.deepseek.com/user/balance', { headers: auth, signal: timeout });
      if (!r.ok) return { error: `HTTP ${r.status}` };
      const d = await r.json();
      const b = d.balance_infos?.[0];
      return b ? { kind: 'balance', currency: b.currency, remaining: Number(b.total_balance), available: d.is_available } : null;
    }
    if (provider.type === 'codice') {
      const r = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/codice/usage`, { headers: auth, signal: timeout });
      if (!r.ok) return { error: `HTTP ${r.status}` };
      return { kind: 'server', ...(await r.json()) };
    }
  } catch (e) {
    return { error: e.message };
  }
  return null;
}

// Extrae el uso de la cola de una respuesta (SSE de OpenAI o NDJSON de Ollama). Usado por `codice serve`.
export function usageFromTail(tail) {
  let input = 0, output = 0;
  for (const raw of tail.split('\n').reverse()) {
    const line = raw.replace(/^data:\s*/, '').trim();
    if (!line.startsWith('{')) continue;
    try {
      const j = JSON.parse(line);
      if (j.usage?.prompt_tokens != null) { input = j.usage.prompt_tokens; output = j.usage.completion_tokens || 0; break; }
      if (j.done && (j.prompt_eval_count != null || j.eval_count != null)) { input = j.prompt_eval_count || 0; output = j.eval_count || 0; break; }
    } catch { /* línea parcial */ }
  }
  return { input, output };
}
