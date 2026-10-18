// Red: WebFetch y WebSearch. Desactivadas con --offline.
import { truncateMiddle } from '../util/fs.js';
import { L } from '../i18n.js';

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
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
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
    const signal = AbortSignal.any ? AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)].filter(Boolean)) : ctx.signal;
    const res = await fetch(url, { headers: { 'User-Agent': 'codice-cli', Accept: 'text/html,application/json,text/plain,*/*' }, signal, redirect: 'follow' });
    const type = res.headers.get('content-type') || '';
    const body = await res.text();
    const text = type.includes('html') ? htmlToText(body) : body;
    const max = Number(a.max_chars) || 20000;
    return {
      content: `URL: ${res.url}\nStatus: ${res.status}\n\n${truncateMiddle(text, max)}`,
      display: `HTTP ${res.status} · ${text.length} ${L('caracteres', 'characters')}`,
      isError: !res.ok,
    };
  },
};

export const WebSearch = {
  name: 'WebSearch',
  readOnly: true,
  network: true,
  description: 'Search the web (DuckDuckGo) and return the top results with title, URL and snippet.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search query' } },
    required: ['query'],
  },
  summary: (a) => `"${a.query}"`,
  permissionKey: () => 'duckduckgo.com',
  async run(a, ctx) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(a.query)}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (codice-cli)' }, signal: ctx.signal });
    const html = await res.text();
    const results = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && results.length < 8) {
      let link = m[1];
      const uddg = link.match(/uddg=([^&]+)/);
      if (uddg) link = decodeURIComponent(uddg[1]);
      results.push(`- ${htmlToText(m[2])}\n  ${link}\n  ${htmlToText(m[3])}`);
    }
    return { content: results.join('\n') || 'No results', display: L(`${results.length} resultados`, `${results.length} results`) };
  },
};
