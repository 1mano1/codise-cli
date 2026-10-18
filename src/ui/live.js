// Zona viva al pie de la terminal: [texto en curso] + [spinner] + [diálogo] + caja de entrada + barra de estado.
// Todo lo que se imprime va ENCIMA de esta zona. Para que no parpadee:
//  - cada cuadro se escribe de una sola vez, dentro de "salida sincronizada" (DEC 2026) y con el cursor oculto;
//  - los renglones se SOBRESCRIBEN (\x1b[K al final) en lugar de borrar la zona y volver a dibujarla.
import { visibleWidth } from './theme.js';

const SYNC_ON = '\x1b[?2026h';
const SYNC_OFF = '\x1b[?2026l';
const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';

const live = {
  active: false,
  rows: 0,
  cursorRow: 0,
  cursorVisible: false,
  renderer: null,
  spinner: null,
  overlay: null,
  stream: null, // renglones del texto que el modelo está escribiendo (aún sin terminar)
};

const out = () => process.stdout;

export function fitLine(s, max) {
  if (visibleWidth(s) <= max) return s;
  let w = 0, res = '';
  const re = /(\x1b\[[0-9;]*m)|([\s\S])/gu;
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) { res += m[1]; continue; }
    const cw = visibleWidth(m[2]);
    if (w + cw > max - 1) break;
    res += m[2];
    w += cw;
  }
  return `${res}…\x1b[0m`;
}

export function liveActive() { return live.active; }
export function setLiveSpinner(fn) { live.spinner = fn; }
export function setOverlay(lines) { live.overlay = lines; }
export function hasOverlay() { return Boolean(live.overlay); }
export function setStreamLines(lines) { live.stream = lines && lines.length ? lines : null; }

// Empuja la zona viva al fondo de la pantalla: la caja de escritura siempre va abajo y la conversación crece
// hacia arriba (como en un chat).
export function anchorBottom() {
  const rows = out().rows || 24;
  out().write('\n'.repeat(Math.max(0, rows - 1)));
  live.rows = 0;
  live.cursorRow = 0;
}

export function startLive(renderer) {
  live.renderer = renderer;
  live.active = true;
  if (out().isTTY) anchorBottom();
  drawLive();
}

export function stopLive() {
  eraseLive();
  if (!live.cursorVisible) out().write(SHOW);
  live.active = false;
}

// Secuencia para volver al primer renglón de la zona.
function toTop() {
  if (!live.rows) return '';
  return `\r${live.cursorRow ? `\x1b[${live.cursorRow}A` : ''}`;
}

// Construye el cuadro completo (sin escribirlo).
function frame() {
  const width = Math.max(20, (out().columns || 80) - 1);
  const pre = [];
  if (live.stream) pre.push(...live.stream);
  if (live.spinner) pre.push(live.spinner());
  if (live.overlay) pre.push(...live.overlay);
  const r = live.renderer({ dim: Boolean(live.overlay) });
  const lines = [...pre, ...r.lines].map((l) => fitLine(l, width));
  let seq = lines.map((l) => `${l}\x1b[0m\x1b[K`).join('\n');
  seq += '\x1b[J'; // limpia lo que sobre si la zona se encogió
  const target = r.cursor ? r.cursor.row + pre.length : lines.length - 1;
  const up = lines.length - 1 - target;
  if (up > 0) seq += `\x1b[${up}A`;
  seq += '\r';
  if (r.cursor?.col > 0) seq += `\x1b[${r.cursor.col}C`;
  return { seq, rows: lines.length, cursorRow: target, showCursor: Boolean(r.cursor) };
}

function commit(prefix, f) {
  out().write(`${SYNC_ON}${HIDE}${prefix}${f.seq}${f.showCursor ? SHOW : ''}${SYNC_OFF}`);
  live.rows = f.rows;
  live.cursorRow = f.cursorRow;
  live.cursorVisible = f.showCursor;
}

export function drawLive() {
  if (!live.active || !live.renderer) return;
  commit(toTop(), frame());
}

export function eraseLive() {
  if (!live.rows) return;
  out().write(`${toTop()}\x1b[J`);
  live.rows = 0;
  live.cursorRow = 0;
}

// Tras limpiar la pantalla, la zona ya no existe: se redibuja desde la posición actual.
export function resetLive() {
  live.rows = 0;
  live.cursorRow = 0;
}

// Escribe texto encima de la zona viva, todo en un solo cuadro.
export function writeAbove(text) {
  const body = text.endsWith('\n') ? text : `${text}\n`;
  if (!live.active || !live.renderer) { out().write(body); return; }
  commit(`${toTop()}\x1b[J${body}`, frame());
}

// Reescribe el renglón inmediatamente encima de la zona (p. ej. la cabecera de una herramienta al terminar).
export function rewriteLineAbove(line) {
  if (!live.active || !live.renderer) return false;
  commit(`${toTop()}\x1b[J\x1b[1A\r\x1b[2K${line}\n`, frame());
  return true;
}
