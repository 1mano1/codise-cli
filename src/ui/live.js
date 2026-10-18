// Zona viva al pie de la terminal: [spinner] + [diálogo] + caja de entrada + barra de estado.
// Todo lo que se imprime va ENCIMA de esta zona: se borra, se escribe y se vuelve a dibujar.
import { visibleWidth } from './theme.js';

const live = {
  active: false,
  rows: 0, // renglones dibujados
  cursorRow: 0, // renglón (dentro de la zona) donde quedó el cursor
  renderer: null, // () => { lines, cursor: { row, col } | null }  (la caja y lo de abajo)
  spinner: null, // () => string
  overlay: null, // string[] (diálogos, menús)
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

export function liveActive() {
  return live.active;
}

export function startLive(renderer) {
  live.renderer = renderer;
  live.active = true;
  drawLive();
}

export function stopLive() {
  eraseLive();
  live.active = false;
}

export function eraseLive() {
  if (!live.rows) return;
  out().write(`\r${live.cursorRow ? `\x1b[${live.cursorRow}A` : ''}\x1b[J`);
  live.rows = 0;
  live.cursorRow = 0;
}

// Tras limpiar la pantalla la zona ya no existe en pantalla: se redibuja desde la posición actual.
export function resetLive() {
  live.rows = 0;
  live.cursorRow = 0;
}

export function setLiveSpinner(fn) {
  live.spinner = fn;
}

export function setOverlay(lines) {
  live.overlay = lines;
}

export function hasOverlay() {
  return Boolean(live.overlay);
}

export function drawLive() {
  if (!live.active || !live.renderer) return;
  eraseLive();
  const width = Math.max(20, (out().columns || 80) - 1);
  const pre = [];
  if (live.spinner) pre.push(live.spinner());
  if (live.overlay) pre.push(...live.overlay);
  const r = live.renderer({ dim: Boolean(live.overlay) });
  const lines = [...pre, ...r.lines].map((l) => fitLine(l, width));
  out().write(lines.join('\n'));
  live.rows = lines.length;
  const target = r.cursor ? r.cursor.row + pre.length : lines.length - 1;
  const up = lines.length - 1 - target;
  let seq = up > 0 ? `\x1b[${up}A` : '';
  seq += '\r';
  if (r.cursor?.col > 0) seq += `\x1b[${r.cursor.col}C`;
  out().write(seq);
  live.cursorRow = target;
}

// Escribe texto encima de la zona viva.
export function writeAbove(text) {
  eraseLive();
  out().write(text.endsWith('\n') ? text : `${text}\n`);
  drawLive();
}
