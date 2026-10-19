// Red: WebFetch, WebSearch y Download. Desactivadas con --offline.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { truncateMiddle, relPath, resolvePath } from '../util/fs.js';
import { L } from '../i18n.js';

// Extensiones que ejecutan código: se avisa al usuario antes de bajarlas.
const EXECUTABLE = /\.(exe|msi|msix|bat|cmd|com|scr|ps1|psm1|vbs|js|jse|wsf|dll|lnk|reg|jar|apk|app|dmg|pkg|deb|rpm|sh|bash|run|bin|appimage)$/i;

// Caché por sesión para no repetir la misma búsqueda o fetch (el modelo a veces insiste en lo mismo).
function cached(ctx, key) {
  const m = (ctx.runtime.__webCache ||= new Map());
  return m.get(key);
}
function remember(ctx, key, result) {
  const m = (ctx.runtime.__webCache ||= new Map());
  if (m.size > 40) m.delete(m.keys().next().value); // tope simple
  m.set(key, result);
  return result;
}

function humanSize(n) {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(0)} KB`;
  return `${n} B`;
}

export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => `\n${'#'.repeat(Number(n))} `)
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

export const WebFetch = {
  name: 'WebFetch',
  readOnly: true,
  network: true,
  description: 'Fetch a URL and return its content as plain text (HTML is converted to text). Use for documentation pages and APIs.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full URL (http/https)' },
      max_chars: { type: 'number', description: 'Maximum characters to return (default 20000)' },
    },
    required: ['url'],
  },
  summary: (a) => a.url,
  permissionKey: (a) => {
    try { return new URL(a.url).hostname; } catch { return a.url; }
  },
  async run(a, ctx) {
    let url;
    try { url = new URL(a.url); } catch { throw new Error(L('URL inválida', 'Invalid URL')); }
    if (!/^https?:$/.test(url.protocol)) throw new Error(L('Solo se permiten URLs http o https', 'Only http and https URLs are allowed'));
    const max = Number(a.max_chars) || 20000;
    const key = `fetch:${url.href}:${max}`;
    const hit = cached(ctx, key);
    if (hit) return { ...hit, content: `${hit.content}\n\n[you already fetched this URL earlier; this is the same result. Do not fetch it again — use it.]` };
    const signal = AbortSignal.any ? AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)].filter(Boolean)) : ctx.signal;
    const res = await fetch(url, { headers: { 'User-Agent': 'codice-cli', Accept: 'text/html,application/json,text/plain,*/*' }, signal, redirect: 'follow' });
    const type = res.headers.get('content-type') || '';
    const body = await res.text();
    const text = type.includes('html') ? htmlToText(body) : body;
    const result = {
      content: `URL: ${res.url}\nStatus: ${res.status}\n\n${truncateMiddle(text, max)}`,
      display: `HTTP ${res.status} · ${text.length} ${L('caracteres', 'characters')}`,
      isError: !res.ok,
    };
    return res.ok ? remember(ctx, key, result) : result;
  },
};

export const Download = {
  name: 'Download',
  network: true,
  edits: true, // escribe un archivo: pasa por el diálogo de permisos como Write/Bash
  description: 'Download a file from a URL and save it to disk (archives, installers, binaries, datasets, releases). Use this instead of WebFetch when you need the actual file, not its text. Follows redirects. Prefer the official source, and pass the published sha256 when the site lists one so the download is verified. Never download from a source the user did not ask for or trust.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full URL to download (http/https). Use the official/vendor source.' },
      path: { type: 'string', description: 'Where to save it (relative to the working directory). If it is a folder or ends with /, the file name is taken from the URL.' },
      sha256: { type: 'string', description: 'Expected SHA-256 checksum (from the official page). If given and it does not match, the file is deleted.' },
      max_mb: { type: 'number', description: 'Maximum size in MB (default 500)' },
    },
    required: ['url'],
  },
  summary: (a) => a.url,
  permissionKey: (a, ctx) => { try { return `${new URL(a.url).hostname} → ${relPath(destPath(a, ctx), ctx.cwd)}`; } catch { return a.url; } },
  preview: (a, ctx) => {
    let host = ''; try { host = new URL(a.url).hostname; } catch { /* url inválida */ }
    const dest = (() => { try { return relPath(destPath(a, ctx), ctx.cwd); } catch { return a.path || ''; } })();
    const warn = EXECUTABLE.test(dest) ? L('  ⚠ es un ejecutable: revisa que la fuente sea oficial y de confianza', '  ⚠ this is an executable: make sure the source is official and trusted') : '';
    return { kind: 'command', command: `${L('Descargar de', 'Download from')} ${host} → ${dest}${a.sha256 ? L('  (se verifica el checksum)', '  (checksum verified)') : ''}${warn}`, description: a.url };
  },
  async run(a, ctx) {
    let url;
    try { url = new URL(a.url); } catch { throw new Error(L('URL inválida', 'Invalid URL')); }
    if (!/^https?:$/.test(url.protocol)) throw new Error(L('Solo se permiten URLs http o https', 'Only http and https URLs are allowed'));
    const dest = destPath(a, ctx);
    const maxBytes = Math.max(1, Number(a.max_mb) || 500) * (1 << 20);
    const signal = AbortSignal.any ? AbortSignal.any([ctx.signal, AbortSignal.timeout(600000)].filter(Boolean)) : ctx.signal;
    const res = await fetch(url, { headers: { 'User-Agent': 'codice-cli', Accept: '*/*' }, signal, redirect: 'follow' });
    if (!res.ok) return { content: `Download failed: HTTP ${res.status} for ${res.url}`, display: `HTTP ${res.status}`, isError: true };
    const declared = Number(res.headers.get('content-length')) || 0;
    if (declared > maxBytes) return { content: `File is ${humanSize(declared)}, over the ${a.max_mb || 500} MB limit. Raise max_mb if you really want it.`, display: L('demasiado grande', 'too large'), isError: true };
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // se escribe por streaming para no cargar el archivo entero en memoria, cortando si pasa el límite, y se
    // calcula el sha256 al vuelo para poder verificar que el archivo es el que publica la fuente oficial
    let written = 0;
    const hash = crypto.createHash('sha256');
    const cap = new Transform({
      transform(chunk, _enc, cb) { written += chunk.length; if (written > maxBytes) { cb(new Error(`exceeded ${a.max_mb || 500} MB`)); } else { hash.update(chunk); cb(null, chunk); } },
    });
    try {
      await pipeline(Readable.fromWeb(res.body), cap, fs.createWriteStream(dest));
    } catch (e) {
      try { fs.unlinkSync(dest); } catch { /* ya no está */ }
      if (e?.name === 'AbortError' || ctx.signal?.aborted) throw Object.assign(new Error(L('Interrumpido por el usuario', 'Interrupted by the user')), { name: 'AbortError' });
      return { content: `Download failed after ${humanSize(written)}: ${e.message}`, display: L('falló la descarga', 'download failed'), isError: true };
    }
    const rel = relPath(dest, ctx.cwd);
    const sum = hash.digest('hex');
    // checksum esperado: si no coincide, el archivo pudo ser manipulado; se borra
    if (a.sha256 && a.sha256.trim().toLowerCase() !== sum) {
      try { fs.unlinkSync(dest); } catch { /* ya no está */ }
      return { content: `Checksum mismatch: expected ${a.sha256.trim()} but got ${sum}. The file was NOT what the official source published, so it was deleted. Do not use it.`, display: L('checksum no coincide · borrado', 'checksum mismatch · deleted'), isError: true };
    }
    ctx.runtime.readFiles?.add(dest);
    const verified = a.sha256 ? L(' · checksum verificado ✓', ' · checksum verified ✓') : '';
    const exe = EXECUTABLE.test(rel)
      ? L(`\n[Es un ejecutable. No lo ejecutes sin que el usuario confirme que la fuente (${res.url}) es oficial y de confianza.${a.sha256 ? '' : ' Si la página oficial publica un sha256, descárgalo de nuevo con ese sha256 para verificarlo.'}]`, `\n[This is an executable. Do not run it unless the user confirms the source (${res.url}) is official and trusted.${a.sha256 ? '' : ' If the official page lists a sha256, download again with it to verify.'}]`)
      : '';
    return { content: `Saved ${humanSize(written)} to ${rel}\nsha256: ${sum}${verified}${exe}`, display: `${rel} · ${humanSize(written)}${verified}`, isError: false };
  },
};

function destPath(a, ctx) {
  const fromUrl = () => { try { return decodeURIComponent(new URL(a.url).pathname.split('/').filter(Boolean).pop() || '') || 'download'; } catch { return 'download'; } };
  let p = String(a.path || '').trim();
  if (!p) return resolvePath(fromUrl(), ctx.cwd);
  const abs = resolvePath(p, ctx.cwd);
  // si apunta a una carpeta (existente o con barra final), se usa el nombre del archivo de la URL
  if (p.endsWith('/') || p.endsWith('\\') || (fs.existsSync(abs) && fs.statSync(abs).isDirectory())) return path.join(abs, fromUrl());
  return abs;
}

// ── Búsqueda web ─────────────────────────────────────────────────
// Motores: Brave y Tavily (con clave, gratis hasta cierto uso), SearXNG (servidor propio) y DuckDuckGo (sin clave).
// "auto" usa el primero configurado y, si falla o lo bloquean, pasa al siguiente.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const ENGINES = {
  async brave(q, { key, signal, count }) {
    const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${count}`, { headers: { Accept: 'application/json', 'X-Subscription-Token': key }, signal });
    if (!r.ok) throw new Error(`Brave HTTP ${r.status}`);
    const j = await r.json();
    return (j.web?.results || []).map((x) => ({ title: x.title, url: x.url, snippet: htmlToText(x.description || ''), age: x.age }));
  },
  async tavily(q, { key, signal, count }) {
    const r = await fetch('https://api.tavily.com/search', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ query: q, max_results: count }), signal });
    if (!r.ok) throw new Error(`Tavily HTTP ${r.status}`);
    const j = await r.json();
    return (j.results || []).map((x) => ({ title: x.title, url: x.url, snippet: String(x.content || '').slice(0, 400) }));
  },
  async searxng(q, { url, signal }) {
    const r = await fetch(`${url.replace(/\/+$/, '')}/search?q=${encodeURIComponent(q)}&format=json`, { headers: { Accept: 'application/json' }, signal });
    if (!r.ok) throw new Error(`SearXNG HTTP ${r.status}`);
    const j = await r.json();
    return (j.results || []).map((x) => ({ title: x.title, url: x.url, snippet: x.content || '', age: x.publishedDate }));
  },
  async duckduckgo(q, { signal }) {
    const blockedPage = (r, html) => r.status !== 200 || /anomaly|challenge-form|captcha/i.test(html);
    const unwrap = (link) => {
      const uddg = link.match(/uddg=([^&]+)/);
      return (uddg ? decodeURIComponent(uddg[1]) : link).replace(/^\/\//, 'https://');
    };
    const out = [];
    let blocked = false;
    const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': UA }, signal });
    const html = await r.text();
    if (blockedPage(r, html)) blocked = true;
    else {
      const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      let m;
      while ((m = re.exec(html))) {
        const link = unwrap(m[1]);
        if (/duckduckgo\.com\/y\.js/.test(link)) continue; // anuncios
        out.push({ title: htmlToText(m[2]), url: link, snippet: htmlToText(m[3]) });
      }
    }
    if (!out.length) {
      // versión "lite" como respaldo (otro servidor y otro HTML)
      const r2 = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': UA }, signal });
      const h2 = await r2.text();
      if (blockedPage(r2, h2)) blocked = true;
      else {
        blocked = false;
        const re2 = /<a[^>]+href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>[\s\S]*?<td class=['"]result-snippet['"]>([\s\S]*?)<\/td>/g;
        let m;
        while ((m = re2.exec(h2))) {
          const link = unwrap(m[1]);
          if (!/duckduckgo\.com\/y\.js/.test(link)) out.push({ title: htmlToText(m[2]), url: link, snippet: htmlToText(m[3]) });
        }
      }
    }
    if (!out.length && blocked) throw new Error(L('DuckDuckGo bloqueó la búsqueda temporalmente', 'DuckDuckGo temporarily blocked the search'));
    return out;
  },
  async bing(q, { signal }) {
    const r = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en`, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal });
    const html = await r.text();
    if (r.status !== 200 || /captcha|challenge/i.test(html.slice(0, 3000))) throw new Error(L('Bing bloqueó la búsqueda temporalmente', 'Bing temporarily blocked the search'));
    const out = [];
    for (const block of html.split('<li class="b_algo"').slice(1)) {
      const a = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!a) continue;
      let link = a[1].replace(/&amp;/g, '&');
      // enlaces de seguimiento: bing.com/ck/a?...&u=a1<url en base64>
      const u = link.includes('bing.com/ck/') && link.match(/[?&]u=a1([^&]+)/);
      if (u) { try { link = Buffer.from(u[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { /* se deja tal cual */ } }
      const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
      out.push({ title: htmlToText(a[2]), url: link, snippet: p ? htmlToText(p[1]).replace(/^Web\s*/, '') : '' });
    }
    return out;
  },
};

// Motores a probar, en orden, según la configuración (settings.webSearch) y las variables de entorno.
export function searchEngines(settings = {}) {
  const ws = settings.webSearch || {};
  const brave = ws.braveKey || process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY;
  const tavily = ws.tavilyKey || process.env.TAVILY_API_KEY;
  const searx = ws.searxngUrl || process.env.SEARXNG_URL;
  const all = [];
  if (brave) all.push({ name: 'brave', key: brave });
  if (tavily) all.push({ name: 'tavily', key: tavily });
  if (searx) all.push({ name: 'searxng', url: searx });
  all.push({ name: 'duckduckgo' }, { name: 'bing' });
  const pick = ws.engine && ws.engine !== 'auto' ? all.filter((e) => e.name === ws.engine) : all;
  return pick.length ? pick : all;
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const matches = (host, d) => { const x = String(d).toLowerCase().replace(/^www\./, ''); return host === x || host.endsWith(`.${x}`); };

export function filterResults(results, { allowed = [], blocked = [] } = {}) {
  const seen = new Set();
  return results.filter((r) => {
    const h = hostOf(r.url);
    if (!h || seen.has(r.url)) return false;
    seen.add(r.url);
    if (allowed.length && !allowed.some((d) => matches(h, d))) return false;
    return !blocked.some((d) => matches(h, d));
  });
}

export const WebSearch = {
  name: 'WebSearch',
  readOnly: true,
  network: true,
  description: 'Search the web for current information (docs, releases, errors, news). Returns titles, URLs and snippets. Then use WebFetch to read the most relevant pages, and cite the URLs you used.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Only include results from these domains' },
      blocked_domains: { type: 'array', items: { type: 'string' }, description: 'Never include results from these domains' },
      max_results: { type: 'number', description: 'Maximum results (default 8)' },
    },
    required: ['query'],
  },
  summary: (a) => `"${a.query}"`,
  permissionKey: () => 'web-search',
  async run(a, ctx) {
    const count = Math.max(1, Math.min(Number(a.max_results) || 8, 20));
    const allowed = Array.isArray(a.allowed_domains) ? a.allowed_domains : [];
    const blocked = Array.isArray(a.blocked_domains) ? a.blocked_domains : [];
    // con un solo dominio permitido, se le pide al buscador directamente
    const q = allowed.length === 1 ? `${a.query} site:${allowed[0]}` : a.query;
    const key = `search:${q}:${allowed.join(',')}:${blocked.join(',')}:${count}`;
    const hit = cached(ctx, key);
    if (hit) return { ...hit, content: `${hit.content}\n\n[you already ran this exact search earlier; same results. Do not search the same thing again — use these results or try a concrete next step.]` };
    const signal = AbortSignal.any ? AbortSignal.any([ctx.signal, AbortSignal.timeout(20000)].filter(Boolean)) : ctx.signal;
    const errors = [];
    for (const eng of searchEngines(ctx.runtime?.settings)) {
      try {
        const raw = await ENGINES[eng.name](q, { ...eng, signal, count: Math.min(20, count * 2) });
        const results = filterResults(raw, { allowed, blocked }).slice(0, count);
        if (!results.length && raw.length) return { content: 'No results match the domain filters.', display: L('0 resultados', '0 results') };
        if (!results.length) { errors.push(`${eng.name}: 0`); continue; }
        const text = results.map((r) => `- ${r.title}${r.age ? ` (${r.age})` : ''}\n  ${r.url}\n  ${r.snippet}`).join('\n');
        return remember(ctx, key, { content: `${text}\n\n(engine: ${eng.name})`, display: L(`${results.length} resultados · ${eng.name}`, `${results.length} results · ${eng.name}`) });
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        errors.push(`${eng.name}: ${e.message}`);
      }
    }
    return {
      content: `No results. ${errors.join('; ')}. For more reliable search set BRAVE_API_KEY or TAVILY_API_KEY (free tiers), or webSearch.searxngUrl in settings.`,
      display: L('sin resultados', 'no results'),
      isError: errors.some((e) => !e.endsWith(': 0')),
    };
  },
};
