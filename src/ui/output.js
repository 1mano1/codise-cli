// Salida en terminal según el diseño de Figma: banner, markdown, herramientas, diffs, cajas, spinner.
import { c, style, stripAnsi, visibleWidth, colorLevel } from './theme.js';
import { renderMascot } from './mascot.js';
import { formatDuration, formatTokens } from '../util/fs.js';

const opts = { screenReader: false, reduceMotion: false, stream: process.stdout };
let lastChar = '\n';
let headerMark = null; // permite reescribir la cabecera de una herramienta si nada se imprimió después

export function configureOutput(o) {
  Object.assign(opts, o);
}

export function isScreenReader() {
  return opts.screenReader;
}

export function width() {
  return Math.max(40, Math.min(opts.stream.columns || 100, 160));
}

export function out(s = '') {
  s = String(s);
  if (!s) return;
  opts.stream.write(s);
  lastChar = s.at(-1);
  headerMark = null;
}

export function println(s = '') {
  out(`${s}\n`);
}

export function ensureNewline() {
  if (lastChar !== '\n') out('\n');
}

export function blank() {
  ensureNewline();
  out('\n');
}

function fit(s, max = width() - 1) {
  // corta texto visible sin romper secuencias ANSI
  if (visibleWidth(s) <= max) return s;
  let w = 0, res = '';
  const re = /(\x1b\[[0-9;]*m)|([\s\S])/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) { res += m[1]; continue; }
    if (w >= max - 1) break;
    res += m[2];
    w++;
  }
  return `${res}…\x1b[0m`;
}

// ── Mensajes simples ─────────────────────────────────────────────
export function info(msg) { ensureNewline(); println(c.muted(msg)); }
export function success(msg) { ensureNewline(); println(`${c.success('✓', { bold: true })} ${c.primary(msg)}`); }
export function warn(msg) { ensureNewline(); println(`${c.warning('⚠', { bold: true })} ${c.warning(msg)}`); }
export function hint(msg) { ensureNewline(); println(c.dim(msg)); }

export function errorBox(title, cause, action) {
  ensureNewline();
  if (opts.screenReader) {
    println(`Error: ${title}.${cause ? ` Causa: ${cause}.` : ''}${action ? ` Qué hacer: ${action}` : ''}`);
    return;
  }
  const lines = [`${c.error(`✗ ${title}`, { bold: true })}${cause ? c.muted(` · ${cause}`) : ''}`];
  if (action) lines.push(c.primary(action));
  box(lines, { border: 'status/error', bg: null });
}

export function box(lines, { border = 'border/default', title = null, padding = 1 } = {}) {
  ensureNewline();
  if (opts.screenReader) {
    if (title) println(stripAnsi(title));
    for (const l of lines) println(stripAnsi(l));
    return;
  }
  const w = Math.min(width() - 2, Math.max(...lines.map(visibleWidth), title ? visibleWidth(title) + 4 : 0) + padding * 2 + 2);
  const inner = w - 2;
  const b = (s) => style(s, { fg: border });
  const top = title ? `╭─ ${title} ${'─'.repeat(Math.max(0, inner - visibleWidth(title) - 3))}╮` : `╭${'─'.repeat(inner)}╮`;
  println(title ? b('╭─ ') + title + b(` ${'─'.repeat(Math.max(0, inner - visibleWidth(title) - 3))}╮`) : b(top));
  for (const l of lines) {
    const content = fit(l, inner - padding * 2);
    const pad = inner - padding * 2 - visibleWidth(content);
    println(`${b('│')}${' '.repeat(padding)}${content}${' '.repeat(Math.max(0, pad))}${' '.repeat(padding)}${b('│')}`);
  }
  println(b(`╰${'─'.repeat(inner)}╯`));
}

// ── Banner de inicio ─────────────────────────────────────────────
const BANNER = [
  '            ▄█▀',
  ' ██████   ██████  ██████  ██  ██████ ███████',
  '██       ██    ██ ██   ██ ██ ██      ██     ',
  '██       ██    ██ ██   ██ ██ ██      █████  ',
  '██       ██    ██ ██   ██ ██ ██      ██     ',
  ' ██████   ██████  ██████  ██  ██████ ███████',
];

export function banner({ version, model, provider, providerUrl, cwd, memory, resources, mascot }) {
  if (opts.screenReader) {
    println(`Códice ${version}. Agente de programación open source.`);
    println(`Modelo ${model || 'sin elegir'} vía ${provider}. Directorio ${cwd}.`);
    println('Escribe /help para ver los comandos.');
    return;
  }
  const art = BANNER.map((l) => c.accent(l, { bold: true }));
  const pet = renderMascot(mascot, 'idle');
  const showPet = pet.length && width() >= 70;
  const rows = Math.max(art.length, showPet ? pet.length : 0);
  const offset = showPet ? Math.max(0, Math.floor((art.length - pet.length) / 2)) : 0;
  println('');
  for (let i = 0; i < rows; i++) {
    const left = art[i] || '';
    const pad = showPet ? ' '.repeat(Math.max(0, 46 - visibleWidth(left))) : '';
    const right = showPet ? (pet[i - offset] || '') : '';
    println(`${left}${pad}${right}`);
  }
  println('');
  println(`${c.primary('codice', { bold: true })} ${c.muted(`v${version}`)}  ${c.dim('·')}  ${c.dim('agente de programación open source para modelos locales y remotos')}`);
  const lines = [
    `${c.dim('modelo     ')}${model ? c.soft(model, { bold: true }) : c.warning('sin elegir — usa /model')}  ${c.muted(`vía ${provider}${providerUrl ? ` (${providerUrl})` : ''}`)}`,
    `${c.dim('directorio ')}${c.info(cwd)}`,
  ];
  if (memory?.length) lines.push(`${c.dim('memoria    ')}${memory.map((m, i) => (i ? c.muted(m) : c.primary(m))).join(c.muted(' · '))}`);
  if (resources) lines.push(`${c.dim('recursos   ')}${resources}`);
  box(lines);
  println('');
  println(c.muted('Consejos', { bold: true }));
  println(`  ${c.accent('/help')}  ${c.muted('ver comandos')}     ${c.accent('/model')}  ${c.muted('cambiar modelo')}     ${c.accent('/init')}  ${c.muted('crear CODICE.md')}`);
  println(`  ${c.accent('!')}  ${c.muted('ejecutar shell')}   ${c.accent('#')}  ${c.muted('guardar en memoria')}     ${c.accent('@')}  ${c.muted('adjuntar archivo')}`);
  println(`  ${c.accent('esc')}  ${c.muted('interrumpir')}     ${c.accent('shift+tab')}  ${c.muted('cambiar modo de permisos')}`);
  println('');
}

// ── Markdown en streaming (por líneas) ───────────────────────────
function inline(s) {
  return s
    .replace(/`([^`]+)`/g, (_, x) => c.info(x))
    .replace(/\*\*([^*]+)\*\*/g, (_, x) => style(x, { bold: true, fg: 'text/primary' }))
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, (_, a, x) => a + style(x, { italic: true, fg: 'text/primary' }))
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_, t, u) => `${c.info(t)} ${c.dim(`(${u})`)}`);
}

export class MarkdownStream {
  constructor({ prefix = '' } = {}) {
    this.buf = '';
    this.inCode = false;
    this.prefix = prefix;
    this.started = false;
  }

  push(text) {
    this.buf += text;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      this.renderLine(this.buf.slice(0, i));
      this.buf = this.buf.slice(i + 1);
    }
  }

  flush() {
    if (this.buf) this.renderLine(this.buf);
    this.buf = '';
  }

  renderLine(line) {
    if (!this.started) {
      if (!line.trim()) return; // sin líneas vacías al inicio
      ensureNewline();
      this.started = true;
    }
    const p = this.prefix;
    if (opts.screenReader) { println(p + line.replace(/^```.*$/, '')); return; }
    if (/^\s*```/.test(line)) {
      this.inCode = !this.inCode;
      const lang = line.trim().slice(3);
      println(p + c.dim(this.inCode ? `╭─ ${lang || 'código'}` : '╰─'));
      return;
    }
    if (this.inCode) { println(p + c.dim('│ ') + c.muted(line)); return; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { println(p + c.accent(h[2], { bold: true })); return; }
    const li = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (li) { println(`${p}${li[1]}  ${c.accent('•')} ${c.primary(inline(li[2]))}`); return; }
    const ol = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (ol) { println(`${p}${ol[1]}  ${c.accent(`${ol[2]}.`)} ${c.primary(inline(ol[3]))}`); return; }
    if (/^\s*>\s?/.test(line)) { println(p + c.dim('┃ ') + c.muted(inline(line.replace(/^\s*>\s?/, '')))); return; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { println(p + c.border('─'.repeat(Math.min(40, width() - 4)))); return; }
    println(p + c.primary(inline(line)));
  }
}

export function reasoningWriter() {
  let started = false;
  let buf = '';
  return {
    push(text) {
      if (opts.screenReader) return;
      buf += text;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!started && !l.trim()) continue;
        if (!started) { ensureNewline(); started = true; }
        if (l.trim()) println(c.dim(`  ${l}`, { italic: true }));
      }
    },
    flush() { if (buf.trim() && !opts.screenReader) { ensureNewline(); println(c.dim(`  ${buf}`, { italic: true })); } buf = ''; },
  };
}

// ── Spinner ──────────────────────────────────────────────────────
const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

export class Spinner {
  constructor() { this.timer = null; this.active = false; }

  start(verb, { label = '' } = {}) {
    this.stop();
    this.verb = verb;
    this.label = label;
    this.t0 = Date.now();
    this.tokens = 0;
    this.active = true;
    if (opts.screenReader) { ensureNewline(); println(`${label ? `${label}: ` : ''}Trabajando…`); this.active = false; return; }
    if (!opts.stream.isTTY || opts.reduceMotion) {
      ensureNewline();
      opts.stream.write(`${c.soft('✻')} ${c.soft(verb, { italic: true })} ${c.dim('(esc para interrumpir)')}`);
      this.static = true;
      return;
    }
    ensureNewline();
    let i = 0;
    const draw = () => {
      const secs = formatDuration(Date.now() - this.t0);
      const tk = this.tokens ? ` · ↓ ${formatTokens(this.tokens)} tokens` : '';
      const line = `${c.soft(FRAMES[i++ % FRAMES.length])} ${this.label ? c.agent(`${this.label} `) : ''}${c.soft(this.verb, { italic: true })} ${c.dim(`(${secs}${tk} · esc para interrumpir)`)}`;
      opts.stream.write(`\r\x1b[2K${fit(line)}`);
    };
    draw();
    this.timer = setInterval(draw, 120);
  }

  addTokens(n) { this.tokens += n; }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; opts.stream.write('\r\x1b[2K'); lastChar = '\n'; }
    if (this.static) { opts.stream.write('\n'); lastChar = '\n'; this.static = false; }
    this.active = false;
  }
}

// ── Herramientas ─────────────────────────────────────────────────
const GLYPH = { running: ['●', 'text/dim'], ok: ['●', 'status/success'], pending: ['○', 'status/warning'], error: ['✗', 'status/error'] };

function header(name, summary, state, indent = '') {
  const [g, col] = GLYPH[state];
  return fit(`${indent}${style(g, { fg: col, bold: true })} ${style(name, { bold: true, fg: 'text/primary' })}${summary ? c.muted(`(${summary})`) : ''}`);
}

export function toolStart(name, summary, { indent = '' } = {}) {
  ensureNewline();
  if (opts.screenReader || !opts.stream.isTTY) return;
  out(`${header(name, summary, 'running', indent)}\n`);
  headerMark = { name, summary, indent };
}

export function toolEnd(name, summary, { ok, text, indent = '' }) {
  if (opts.screenReader) {
    println(`Herramienta ${name}${ok ? ', correcta' : ', con error'}${summary ? `: ${summary}` : ''}. ${text || ''}`.trim());
    return;
  }
  if (headerMark && headerMark.name === name && opts.stream.isTTY && colorLevel() > 0) {
    opts.stream.write(`\x1b[1A\r\x1b[2K${header(name, summary, ok ? 'ok' : 'error', indent)}\n`);
  } else {
    ensureNewline();
    println(header(name, summary, ok ? 'ok' : 'error', indent));
  }
  headerMark = null;
  if (text) {
    const first = String(text).split('\n');
    const main = first[0];
    const lineTxt = ok ? c.dim(main) : c.error(`Error: ${main.replace(/^Error:\s*/i, '')}`);
    println(fit(`${indent}  ${c.dim('└')} ${lineTxt}`));
    if (ok) for (const extra of first.slice(1, 4)) println(fit(`${indent}    ${c.dim(extra)}`));
  }
}

export function subStep(agentLabel, name, summary) {
  if (opts.screenReader) { println(`Subagente ${agentLabel}: ${name} ${summary || ''}`); return; }
  ensureNewline();
  println(fit(`    ${c.agent('↳', { bold: true })} ${c.agent(agentLabel.padEnd(9))}${style(name, { bold: true, fg: 'text/muted' })}${summary ? c.dim(`(${summary})`) : ''}`));
}

// ── Diff ─────────────────────────────────────────────────────────
function lcsDiff(a, b) {
  const n = a.length, m = b.length;
  if (n * m > 250000) return [...a.map((l) => ['-', l]), ...b.map((l) => ['+', l])];
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const res = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { res.push([' ', a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) res.push(['-', a[i++]]);
    else res.push(['+', b[j++]]);
  }
  while (i < n) res.push(['-', a[i++]]);
  while (j < m) res.push(['+', b[j++]]);
  return res;
}

export function diffStats(oldText, newText) {
  const d = lcsDiff(String(oldText).split('\n'), String(newText).split('\n'));
  return { added: d.filter((x) => x[0] === '+').length, removed: d.filter((x) => x[0] === '-').length };
}

export function printDiff(oldText, newText, { startLine = 1, maxLines = 24, indent = '  ' } = {}) {
  const d = lcsDiff(String(oldText).split('\n'), String(newText).split('\n'));
  if (opts.screenReader) {
    const st = diffStats(oldText, newText);
    println(`Cambios: ${st.added} líneas añadidas, ${st.removed} eliminadas.`);
    return;
  }
  // recorta contexto: muestra cambios con 2 líneas alrededor
  const keep = new Array(d.length).fill(false);
  d.forEach((x, k) => { if (x[0] !== ' ') for (let t = Math.max(0, k - 2); t <= Math.min(d.length - 1, k + 2); t++) keep[t] = true; });
  let oldNo = startLine, newNo = startLine, shown = 0, skipped = false;
  const w = Math.min(width() - indent.length - 1, 120);
  for (let k = 0; k < d.length; k++) {
    const [sign, text] = d[k];
    const no = sign === '+' ? newNo : oldNo;
    if (sign !== '+') oldNo++;
    if (sign !== '-') newNo++;
    if (!keep[k]) { skipped = true; continue; }
    if (skipped) { println(indent + c.dim('   ⋮')); skipped = false; }
    if (shown++ >= maxLines) { println(indent + c.dim(`   … ${d.length - k} líneas más (ctrl+o para ver todo)`)); break; }
    const content = `${String(no).padStart(4)} ${sign} ${text}`;
    const padded = content.length < w ? content + ' '.repeat(w - visibleWidth(content)) : fit(content, w);
    if (sign === '+') println(indent + style(padded, { fg: 'text/primary', bg: 'diff/add-bg' }).replace(` + `, ` ${style('+', { fg: 'status/success', bg: 'diff/add-bg', bold: true })}${style(' ', { bg: 'diff/add-bg' })}`));
    else if (sign === '-') println(indent + style(padded, { fg: 'text/primary', bg: 'diff/del-bg' }).replace(` - `, ` ${style('-', { fg: 'status/error', bg: 'diff/del-bg', bold: true })}${style(' ', { bg: 'diff/del-bg' })}`));
    else println(indent + c.dim(padded));
  }
}

// ── Tareas ───────────────────────────────────────────────────────
export function printTodos(todos) {
  if (opts.screenReader) {
    todos.forEach((t, i) => println(`Tarea ${i + 1}, ${t.status === 'completed' ? 'hecha' : t.status === 'in_progress' ? 'en curso' : 'pendiente'}: ${t.content}`));
    return;
  }
  for (const t of todos) {
    if (t.status === 'completed') println(`      ${c.success('☑')} ${style(t.content, { fg: 'text/dim', strike: true })}`);
    else if (t.status === 'in_progress') println(`      ${c.accent('◐', { bold: true })} ${style(t.content, { bold: true, fg: 'text/primary' })}`);
    else println(`      ${c.muted('☐')} ${c.muted(t.content)}`);
  }
}

// ── Línea del usuario (eco en modo no interactivo) ───────────────
export function userEcho(text) {
  ensureNewline();
  println(`${c.accent('›', { bold: true })} ${c.primary(text)}`);
}

export function rule() {
  if (opts.screenReader) return;
  println(c.border('─'.repeat(width() - 1)));
}
