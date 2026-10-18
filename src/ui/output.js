// Salida en terminal según el diseño de Figma: banner, markdown, herramientas, diffs, cajas, spinner.
import { c, style, stripAnsi, visibleWidth, colorLevel } from './theme.js';
import { renderMascot } from './mascot.js';
import { formatDuration, formatTokens } from '../util/fs.js';
import { L } from '../i18n.js';
import { liveActive, writeAbove, eraseLive, drawLive, setLiveSpinner, resetLive, rewriteLineAbove, setStreamLines, anchorBottom } from './live.js';

const opts ={ screenReader: false, reduceMotion: false, stream: process.stdout };
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

let activeSpinner = null;

// Historial de lo impreso con la caja activa: al cambiar el tamaño de la terminal se limpia la pantalla y se
// vuelve a dibujar. Los bloques que dependen del ancho (bienvenida, diffs) se guardan como funciones.
const history = [];
const MAX_HISTORY = 400;

function record(entry) {
  history.push(entry);
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  return entry;
}

// Imprime un bloque que se recalcula al cambiar el ancho de la terminal.
export function outBlock(render) {
  const text = render();
  if (!text) return;
  if (liveActive() && opts.stream === process.stdout) {
    record({ render });
    writeAbove(text);
    lastChar = '\n';
    headerMark = null;
    return;
  }
  out(text);
}

let resizeTimer = null;
export function handleResize() {
  if (!liveActive() || opts.screenReader) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    eraseLive();
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
    anchorBottom(); // la caja sigue abajo; la conversación se vuelve a dibujar encima, al nuevo ancho
    const text = history.map((e) => (e.render ? e.render() : e.text)).join('');
    if (text) process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    drawLive();
  }, 120);
}

// Escribe respetando la zona viva (caja de entrada) o el spinner: los borra, escribe y los vuelve a dibujar.
export function out(s = '') {
  s = String(s);
  if (!s) return;
  if (liveActive() && opts.stream === process.stdout) {
    record({ text: s.endsWith('\n') ? s : `${s}\n` });
    writeAbove(s);
    lastChar = '\n';
    headerMark = null;
    return;
  }
  const sp = activeSpinner?.timer ? activeSpinner : null;
  if (sp) opts.stream.write('\r\x1b[2K');
  opts.stream.write(s);
  lastChar = s.at(-1);
  headerMark = null;
  if (sp) {
    if (lastChar !== '\n') { opts.stream.write('\n'); lastChar = '\n'; }
    sp.draw();
  }
}

export function getHeaderMark() { return headerMark; }
export function setHeaderMark(m) { headerMark = m; }

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

// Corta una línea al ancho visible de la terminal (sin romper colores). Evita que se parta en dos renglones.
export function fit(s, max = width() - 1) {
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
export function warn(msg) { ensureNewline(); for (const [i, l] of wrap(msg, width() - 3).entries()) println(`${i ? ' ' : c.warning('⚠', { bold: true })} ${c.warning(l)}`); }
export function hint(msg) { ensureNewline(); for (const l of wrap(msg, width() - 1)) println(c.dim(l)); }

// Ajusta texto plano al ancho (por palabras).
export function wrap(text, max = width() - 2) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      if (line && visibleWidth(line) + 1 + visibleWidth(word) > max) { out.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    out.push(line);
  }
  return out;
}

// Error en dos líneas: qué pasó y qué hacer. La causa técnica solo si no hay acción sugerida.
export function errorBox(title, cause, action) {
  ensureNewline();
  if (opts.screenReader) {
    println(`Error: ${title}.${action ? ` ${action}` : cause ? ` ${cause}.` : ''}`);
    return;
  }
  println(`${c.error('✗', { bold: true })} ${c.error(title, { bold: true })}`);
  const detail = action || cause;
  if (detail) for (const l of wrap(detail, width() - 3)) println(`  ${action ? c.primary(l) : c.dim(l)}`);
  if (action && cause && process.env.CODICE_DEBUG) println(`  ${c.dim(cause)}`);
}

export function box(lines, o = {}) {
  ensureNewline();
  if (opts.screenReader) {
    if (o.title) println(stripAnsi(o.title));
    for (const l of lines) println(stripAnsi(l));
    return;
  }
  out(boxString(lines, o)); // de una vez: sin parpadeo con la zona viva
}

// Devuelve el recuadro como texto (se recalcula con el ancho actual de la terminal).
export function boxString(lines, { border = 'border/default', title = null, padding = 1, full = false } = {}) {
  const maxInner = width() - 4 - padding * 2;
  const rows = lines.flatMap((l) => (visibleWidth(l) > maxInner && !/\x1b/.test(l) ? wrap(l, maxInner) : [l]));
  // full: mismo ancho que la caja de escritura (alineados, diseño v2)
  const w = full ? Math.max(24, (opts.stream.columns || 80) - 1) : Math.min(width() - 2, Math.max(...rows.map(visibleWidth), title ? visibleWidth(title) + 4 : 0) + padding * 2 + 2);
  const inner = w - 2;
  const b = (s) => style(s, { fg: border });
  const outLines = [title ? b('╭─ ') + title + b(` ${'─'.repeat(Math.max(0, inner - visibleWidth(title) - 3))}╮`) : b(`╭${'─'.repeat(inner)}╮`)];
  for (const l of rows) {
    const content = fit(l, inner - padding * 2);
    const pad = inner - padding * 2 - visibleWidth(content);
    outLines.push(`${b('│')}${' '.repeat(padding)}${content}${' '.repeat(Math.max(0, pad))}${' '.repeat(padding)}${b('│')}`);
  }
  outLines.push(b(`╰${'─'.repeat(inner)}╯`));
  return `${outLines.join('\n')}\n`;
}

// ── Banner de inicio ─────────────────────────────────────────────
export const BANNER = [
  '            ▄█▀',
  ' ██████   ██████  ██████  ██  ██████ ███████',
  '██       ██    ██ ██   ██ ██ ██      ██     ',
  '██       ██    ██ ██   ██ ██ ██      █████  ',
  '██       ██    ██ ██   ██ ██ ██      ██     ',
  ' ██████   ██████  ██████  ██  ██████ ███████',
];

export function artWithMascot(mascot, { state = 'idle' } = {}) {
  const art = BANNER.map((l) => c.accent(l, { bold: true }));
  const pet = renderMascot(mascot, state);
  const showPet = pet.length && width() >= 70;
  const rows = Math.max(art.length, showPet ? pet.length : 0);
  const offset = showPet ? Math.max(0, Math.floor((art.length - pet.length) / 2)) : 0;
  const out = [];
  for (let i = 0; i < rows; i++) {
    const left = art[i] || '';
    const pad = showPet ? ' '.repeat(Math.max(0, 46 - visibleWidth(left))) : '';
    out.push(`${left}${pad}${showPet ? (pet[i - offset] || '') : ''}`);
  }
  return out;
}

// Pantalla de inicio mínima: marca, una línea de estado y una de ayuda.
export function banner({ version, model, provider, cwd, memory, mascot }) {
  if (opts.screenReader) {
    println(L(`Códice ${version}. Agente de programación open source.`, `Códice ${version}. Open-source coding agent.`));
    println(model ? L(`Modelo ${model} vía ${provider}.`, `Model ${model} via ${provider}.`) : L('Sin modelo configurado. Escribe /setup.', 'No model configured. Type /setup.'));
    println(L('Escribe /help para ver los comandos.', 'Type /help to see the commands.'));
    return;
  }
  // Diseño v2: contenedor compacto con la mascota pequeña a la izquierda y la información a la derecha.
  // Es responsivo: se recalcula con el ancho actual (al redimensionar se vuelve a dibujar) y en ventanas
  // angostas la mascota se oculta y los textos se acortan.
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const shortCwd = home && cwd.toLowerCase().startsWith(home.toLowerCase()) ? `~${cwd.slice(home.length)}` : cwd;
  const render = () => {
    const cols = (opts.stream.columns || 80) - 1;
    const pet = cols >= 64 ? renderMascot(mascot, 'idle') : [];
    const petW = pet.length ? visibleWidth(pet[0]) : 0;
    const narrow = cols < 48;
    const lbl = (s) => (narrow ? '' : c.dim(s.padEnd(9)));
    const info = [
      `${c.accent('✻', { bold: true })} ${c.primary('Códice', { bold: true })}  ${c.dim(`v${version}`)}`,
      `${lbl(L('modelo', 'model'))}${model ? `${c.soft(model, { bold: true })}${narrow ? '' : `  ${c.muted(`· ${provider}`)}`}` : c.warning(L('sin modelo — /setup', 'no model — /setup'))}`,
      `${lbl(L('carpeta', 'folder'))}${c.info(shortCwd)}`,
    ];
    if (memory?.length && !narrow) info.push(`${lbl(L('memoria', 'memory'))}${c.muted(memory.slice(0, 3).join(' · '))}`);
    info.push(narrow ? `${c.accent('/help')}` : `${c.accent('/help')} ${c.dim(L('comandos', 'commands'))}${c.dim(' · ')}${c.accent('/models')} ${c.dim(L('modelo', 'model'))}${c.dim(' · ')}${c.accent('/theme')} ${c.dim(L('tema', 'theme'))}`);
    const rows = Math.max(pet.length, info.length);
    const offPet = Math.max(0, Math.floor((rows - pet.length) / 2));
    const offInfo = Math.max(0, Math.floor((rows - info.length) / 2));
    const lines = [];
    for (let i = 0; i < rows; i++) {
      const p = petW ? (pet[i - offPet] || ' '.repeat(petW)) : '';
      lines.push(`${p}${petW ? '   ' : ''}${info[i - offInfo] || ''}`);
    }
    return `\n${boxString(lines, { border: 'accent/primary', full: liveActive() })}`;
  };
  ensureNewline();
  outBlock(render);
}

// Limpia la pantalla sin romper la zona viva (se vuelve a dibujar al pie).
// bottom: deja la zona viva pegada al fondo (para pantallas con caja); sin él, el texto empieza arriba (asistente).
export function clearScreen({ bottom = false } = {}) {
  if (!process.stdout.isTTY || opts.screenReader) return;
  eraseLive();
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  resetLive();
  if (bottom) anchorBottom();
  history.length = 0;
  lastChar = '\n';
  drawLive();
}

// ── Markdown en streaming (por líneas) ───────────────────────────
function inline(s) {
  return s
    .replace(/`([^`]+)`/g, (_, x) => c.info(x))
    .replace(/\*\*([^*]+)\*\*/g, (_, x) => style(x, { bold: true, fg: 'text/primary' }))
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, (_, a, x) => a + style(x, { italic: true, fg: 'text/primary' }))
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_, t, u) => `${c.info(t)} ${c.dim(`(${u})`)}`);
}

// Redibuja la zona viva como mucho cada ~30 ms mientras llega texto (fluido sin saturar la terminal).
let drawTimer = null;
function scheduleDraw() {
  if (drawTimer) return;
  drawTimer = setTimeout(() => { drawTimer = null; drawLive(); }, 30);
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
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      this.updateTail(false);
      this.renderLine(line);
    }
    this.updateTail(true);
  }

  // El renglón que aún se está escribiendo se ve en la zona viva, palabra por palabra (no aparece de golpe).
  updateTail(schedule) {
    if (!liveActive() || opts.screenReader || opts.stream !== process.stdout) return;
    const part = this.buf;
    if (!part || (!this.started && !part.trim())) { setStreamLines(null); if (schedule) scheduleDraw(); return; }
    const cols = Math.max(20, (opts.stream.columns || 80) - 3);
    const p = this.prefix;
    const lines = wrap(part, cols).map((chunk) => (this.inCode ? `${p}${c.dim('│ ')}${c.muted(chunk)}` : `${p}${c.primary(inline(chunk))}`));
    setStreamLines(lines);
    if (schedule) scheduleDraw();
  }

  flush() {
    setStreamLines(null);
    if (this.buf) this.renderLine(this.buf);
    else drawLive();
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
      println(p + c.dim(this.inCode ? `╭─ ${lang || L('código', 'code')}` : '╰─'));
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
    if (opts.screenReader) { ensureNewline(); println(`${label ? `${label}: ` : ''}${L('Trabajando…', 'Working…')}`); this.active = false; return; }
    // Con la caja de entrada activa, el spinner vive en la zona fija, justo encima de la caja.
    if (liveActive() && opts.stream === process.stdout) {
      let i = 0;
      const lineFn = () => {
        const secs = formatDuration(Date.now() - this.t0);
        const tk = this.tokens ? ` · ↓ ${formatTokens(this.tokens)} tokens` : '';
        const frame = opts.reduceMotion ? '✻' : FRAMES[i % FRAMES.length];
        return `${c.soft(frame)} ${this.label ? c.agent(`${this.label} `) : ''}${c.soft(this.verb, { italic: true })}  ${c.dim(`${secs}${tk} · ${L('esc interrumpe', 'esc interrupts')}`)}`;
      };
      setLiveSpinner(lineFn);
      this.liveMode = true;
      drawLive();
      if (!opts.reduceMotion) this.timer = setInterval(() => { i++; drawLive(); }, 150);
      else this.timer = setInterval(() => drawLive(), 1000);
      return;
    }
    if (!opts.stream.isTTY || opts.reduceMotion) {
      ensureNewline();
      opts.stream.write(`${c.soft('✻')} ${c.soft(verb, { italic: true })} ${c.dim(L('(esc para interrumpir)', '(esc to interrupt)'))}`);
      this.static = true;
      return;
    }
    ensureNewline();
    let i = 0;
    this.draw = () => {
      const secs = formatDuration(Date.now() - this.t0);
      const tk = this.tokens ? ` · ↓ ${formatTokens(this.tokens)} tokens` : '';
      const line = `${c.soft(FRAMES[i++ % FRAMES.length])} ${this.label ? c.agent(`${this.label} `) : ''}${c.soft(this.verb, { italic: true })} ${c.dim(`(${secs}${tk} · ${L('esc para interrumpir', 'esc to interrupt')})`)}`;
      opts.stream.write(`\r\x1b[2K${fit(line)}`);
    };
    this.draw();
    this.timer = setInterval(this.draw, 120);
    activeSpinner = this;
  }

  setVerb(verb) { this.verb = verb; }

  addTokens(n) { this.tokens += n; }

  stop() {
    if (this.liveMode) {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      this.liveMode = false;
      setLiveSpinner(null);
      drawLive();
      this.active = false;
      return;
    }
    if (this.timer) { clearInterval(this.timer); this.timer = null; opts.stream.write('\r\x1b[2K'); lastChar = '\n'; }
    if (this.static) { opts.stream.write('\n'); lastChar = '\n'; this.static = false; }
    if (activeSpinner === this) activeSpinner = null;
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
  // la cabecera se recalcula al redimensionar (se corta al ancho actual) y cambia de estado al terminar
  const st = { state: 'running' };
  outBlock(() => `${header(name, summary, st.state, indent)}\n`);
  headerMark = { name, summary, indent, st };
}

export function toolEnd(name, summary, { ok, text, indent = '' }) {
  if (opts.screenReader) {
    println(`${L('Herramienta', 'Tool')} ${name}${ok ? L(', correcta', ', succeeded') : L(', con error', ', failed')}${summary ? `: ${summary}` : ''}. ${text || ''}`.trim());
    return;
  }
  if (headerMark && headerMark.name === name && liveActive() && opts.stream === process.stdout && colorLevel() > 0) {
    // la cabecera está justo encima de la zona viva: se reescribe en el mismo cuadro (sin parpadeo)
    headerMark.st.state = ok ? 'ok' : 'error';
    rewriteLineAbove(header(name, summary, headerMark.st.state, indent));
    lastChar = '\n';
  } else if (headerMark && headerMark.name === name && opts.stream.isTTY && colorLevel() > 0) {
    const sp = activeSpinner?.timer ? activeSpinner : null;
    opts.stream.write(`${sp ? '\r\x1b[2K' : ''}\x1b[1A\r\x1b[2K${header(name, summary, ok ? 'ok' : 'error', indent)}\n`);
    lastChar = '\n';
    if (sp) sp.draw();
  } else {
    ensureNewline();
    println(header(name, summary, ok ? 'ok' : 'error', indent));
  }
  headerMark = null;
  if (text) {
    const first = String(text).split('\n');
    const main = first[0];
    const lineTxt = ok ? c.dim(main) : c.error(`${L('Error', 'Error')}: ${main.replace(/^Error:\s*/i, '')}`);
    println(fit(`${indent}  ${c.dim('└')} ${lineTxt}`));
    if (ok) for (const extra of first.slice(1, 4)) println(fit(`${indent}    ${c.dim(extra)}`));
  }
}

export function subStep(agentLabel, name, summary) {
  if (opts.screenReader) { println(`${L('Subagente', 'Subagent')} ${agentLabel}: ${name} ${summary || ''}`); return; }
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

// Devuelve las líneas del diff ya coloreadas (contexto de 2 líneas alrededor de cada cambio).
export function diffLines(oldText, newText, { startLine = 1, maxLines = 24, indent = '  ' } = {}) {
  // archivo nuevo: no hay líneas viejas (si no, las líneas vacías se emparejaban con "" y salían sin +)
  const d = lcsDiff(oldText === '' ? [] : String(oldText).split('\n'), String(newText).split('\n'));
  if (opts.screenReader) {
    const st = diffStats(oldText, newText);
    return [L(`Cambios: ${st.added} líneas añadidas, ${st.removed} eliminadas.`, `Changes: ${st.added} lines added, ${st.removed} removed.`)];
  }
  const lines = [];
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
    if (skipped) { lines.push(indent + c.dim('   ⋮')); skipped = false; }
    if (shown++ >= maxLines) { lines.push(indent + c.dim(L(`   … ${d.length - k} líneas más`, `   … ${d.length - k} more lines`))); break; }
    const num = `${String(no).padStart(4)} `;
    const code = fit(text, w - num.length - 2);
    const pad = ' '.repeat(Math.max(0, w - num.length - 2 - visibleWidth(code)));
    if (sign === ' ') { lines.push(indent + c.dim(`${num}  ${code}`)); continue; }
    const bg = sign === '+' ? 'diff/add-bg' : 'diff/del-bg';
    const signColor = sign === '+' ? 'status/success' : 'status/error';
    lines.push(indent + style(num, { fg: 'text/dim', bg }) + style(`${sign} `, { fg: signColor, bg, bold: true }) + style(code + pad, { fg: 'text/primary', bg }));
  }
  return lines;
}

export function printDiff(oldText, newText, o = {}) {
  // se recalcula al redimensionar (el fondo de color ocupa el ancho de la terminal)
  outBlock(() => {
    const lines = diffLines(oldText, newText, o);
    return lines.length ? `${lines.join('\n')}\n` : '';
  });
}

// ── Tareas ───────────────────────────────────────────────────────
export function printTodos(todos) {
  if (opts.screenReader) {
    todos.forEach((t, i) => println(`${L('Tarea', 'Task')} ${i + 1}, ${t.status === 'completed' ? L('hecha', 'done') : t.status === 'in_progress' ? L('en curso', 'in progress') : L('pendiente', 'pending')}: ${t.content}`));
    return;
  }
  const lines = todos.map((t) => {
    if (t.status === 'completed') return `      ${c.success('☑')} ${style(t.content, { fg: 'text/dim', strike: true })}`;
    if (t.status === 'in_progress') return `      ${c.accent('◐', { bold: true })} ${style(t.content, { bold: true, fg: 'text/primary' })}`;
    return `      ${c.muted('☐')} ${c.muted(t.content)}`;
  });
  if (lines.length) out(`${lines.join('\n')}\n`);
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
