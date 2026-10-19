// Compresión gzip del cuerpo de las peticiones al modelo. Cada turno reenvía toda la conversación (decenas o
// cientos de KB); comprimida viaja ~2.5-6 veces más ligera y la respuesta empieza antes, sobre todo con internet
// lento o subida limitada. No acelera la generación de tokens, solo el envío.
import zlib from 'node:zlib';
import { safeFetch } from './openai.js';

const MIN_BYTES = 1024; // por debajo no vale la pena
const rejected = new Set(); // servidores que no aceptan cuerpos comprimidos (se recuerda en esta ejecución)

// auto: solo donde se sabe que se acepta: la API de Anthropic (igual que Claude Code) y la PC remota con
// `codice serve`. Para otros proveedores se activa con compressRequests: true (si lo rechazan, se reenvía plano).
export function wantsGzip(settings, provider) {
  if (process.env.CODICE_GZIP === '0') return false;
  const mode = settings?.compressRequests ?? 'auto';
  if (!provider?.baseUrl || provider.type === 'local') return false;
  if (mode === true || mode === false) return mode;
  return provider.type === 'codice' || /^https:\/\/api\.anthropic\.com/i.test(provider.baseUrl);
}

export function originOf(url) {
  try { return new URL(url).origin; } catch { return url; }
}

// POST con JSON, comprimido si procede. Si el servidor rechaza el cuerpo comprimido, se reenvía sin comprimir
// y, si así funciona, ya no se comprime para ese servidor.
export async function postJSON(url, { headers, body, signal, gzip = false }, label) {
  const json = JSON.stringify(body);
  const key = originOf(url);
  const compress = gzip && !rejected.has(key) && Buffer.byteLength(json) >= MIN_BYTES;
  if (!compress) return safeFetch(url, { method: 'POST', headers, body: json, signal }, label);
  const res = await safeFetch(url, { method: 'POST', headers: { ...headers, 'Content-Encoding': 'gzip' }, body: zlib.gzipSync(json, { level: 6 }), signal }, label);
  if (res.status !== 400 && res.status !== 415 && res.status !== 422) return res;
  const plain = await safeFetch(url, { method: 'POST', headers, body: json, signal }, label);
  if (plain.ok) rejected.add(key);
  return plain;
}

export function gzipRejected(url) { return rejected.has(originOf(url)); }
