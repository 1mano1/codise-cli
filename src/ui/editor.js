// Caja de escritura fija al pie (diseño v2): crece con el texto, paleta "/" debajo, estado debajo,
// historial, pegado de varias líneas, escritura anticipada mientras el agente trabaja.
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { c, style, visibleWidth } from './theme.js';
import { startLive, stopLive, drawLive, writeAbove, liveActive } from './live.js';
import { L } from '../i18n.js';
import { wrap } from './output.js';

const MAX_HISTORY = 500;
const MAX_ROWS = 8;

export class BoxInput {
  constructor({ historyFile, getCommands = () => [], getStatus = () => '', onModeCycle, onInterrupt, onExpand, onExit } = {}) {
    Object.assign(this, { historyFile, getCommands, getStatus, onModeCycle, onInterrupt, onExpand, onExit });
    this.tty = true;
    this.box = true;
    this.state = 'idle'; // idle | prompt | busy | modal | ask
    this.buffer = '';
    this.cursor = 0;
    this.history = [];
    this.histIndex = -1;
    this.draft = '';
    this.palette = { sel: 0, dismissed: false, items: [] };
    this.queued = null;
    this.asking = null;
    this.modalHandler = null;
    this.pasting = false;
    this.closed = false;
  }

  // ── Ciclo de vida ──────────────────────────────────────────────
  start() {
    try { this.history = fs.readFileSync(this.historyFile, 'utf8').split('\n').filter(Boolean).slice(-MAX_HISTORY); } catch { this.history = []; }
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    this.onKeyBound = (s, key) => this.onKey(s, key || {});
    process.stdin.on('keypress', this.onKeyBound);
    process.stdout.write('\x1b[?2004h'); // pegado entre corchetes: pegar varias líneas no envía
    this.onResize = () => drawLive();
    process.stdout.on('resize', this.onResize);
    this.restore = () => { try { process.stdout.write('\x1b[?2004l'); } catch { /* cerrado */ } };
    process.on('exit', this.restore);
    startLive((o) => this.render(o));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    stopLive();
    process.stdin.off('keypress', this.onKeyBound);
    process.stdout.off('resize', this.onResize);
    this.restore();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    if (this.pending) { const r = this.pending; this.pending = null; r(null); }
  }

  saveHistory(line) {
    if (!line.trim()) return;
    if (this.history.at(-1) !== line) this.history.push(line);
    try {
      fs.mkdirSync(path.dirname(this.historyFile), { recursive: true });
      fs.appendFileSync(this.historyFile, `${line.replace(/\n/g, ' ')}\n`);
    } catch { /* sin historial */ }
  }

  // ── API usada por la consola ───────────────────────────────────
  prompt() {
    if (this.closed) return Promise.resolve(null);
    if (this.queued != null) {
      const q = this.queued;
      this.queued = null;
      this.echo(q);
      return Promise.resolve(q);
    }
    this.state = 'prompt';
    this.palette.dismissed = false;
    drawLive();
    return new Promise((resolve) => { this.pending = resolve; });
  }

  question(label) { return this.ask(label, false); }
  secret(label) { return this.ask(label, true); }

  ask(label, secret) {
    const prev = this.state;
    const saved = { buffer: this.buffer, cursor: this.cursor };
    this.buffer = '';
    this.cursor = 0;
    this.state = 'ask';
    return new Promise((resolve) => {
      this.asking = {
        label: String(label || '').replace(/\s+$/, ''),
        secret,
        resolve: (v) => {
          this.asking = null;
          this.state = prev === 'ask' ? 'idle' : prev;
          this.buffer = saved.buffer;
          this.cursor = saved.cursor;
          drawLive();
          resolve(v);
        },
      };
      drawLive();
    });
  }

  setBusy(b) {
    this.state = b ? 'busy' : 'idle';
    drawLive();
  }

  modal(handler) {
    const prev = this.state;
    this.modalHandler = handler;
    this.state = 'modal';
    return () => {
      this.modalHandler = null;
      this.state = prev === 'modal' ? 'idle' : prev;
      drawLive();
    };
  }

  refreshBelow() { drawLive(); }

  // Mensaje del usuario en la conversación, ya fuera de la caja.
  echo(text) {
    // se ajusta al ancho con sangría, para que las líneas siguientes queden alineadas bajo el texto
    const lines = wrap(text, Math.max(20, (process.stdout.columns || 80) - 4));
    const out = lines.map((l, i) => (i === 0 ? `${c.accent('›', { bold: true })} ${c.primary(l)}` : `  ${c.primary(l)}`)).join('\n');
    writeAbove(`\n${out}`);
  }

  // ── Edición ────────────────────────────────────────────────────
  insert(s) {
    this.buffer = this.buffer.slice(0, this.cursor) + s + this.buffer.slice(this.cursor);
    this.cursor += s.length;
    this.histIndex = -1;
    if (!this.buffer.startsWith('/')) this.palette.dismissed = false;
  }

  deleteBack(n = 1) {
    if (!this.cursor) return;
    const from = Math.max(0, this.cursor - n);
    this.buffer = this.buffer.slice(0, from) + this.buffer.slice(this.cursor);
    this.cursor = from;
  }

  wordLeft() {
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.buffer[i - 1])) i--;
    while (i > 0 && !/\s/.test(this.buffer[i - 1])) i--;
    return i;
  }

  wordRight() {
    let i = this.cursor;
    while (i < this.buffer.length && /\s/.test(this.buffer[i])) i++;
    while (i < this.buffer.length && !/\s/.test(this.buffer[i])) i++;
    return i;
  }

  lineBounds() {
    const start = this.buffer.lastIndexOf('\n', this.cursor - 1) + 1;
    let end = this.buffer.indexOf('\n', this.cursor);
    if (end < 0) end = this.buffer.length;
    return { start, end };
  }

  moveVertical(dir) {
    const { start } = this.lineBounds();
    const col = this.cursor - start;
    if (dir < 0) {
      if (start === 0) return false;
      const prevEnd = start - 1;
      const prevStart = this.buffer.lastIndexOf('\n', prevEnd - 1) + 1;
      this.cursor = Math.min(prevStart + col, prevEnd);
    } else {
      const nextStart = this.buffer.indexOf('\n', this.cursor);
      if (nextStart < 0) return false;
      let nextEnd = this.buffer.indexOf('\n', nextStart + 1);
      if (nextEnd < 0) nextEnd = this.buffer.length;
      this.cursor = Math.min(nextStart + 1 + col, nextEnd);
    }
    return true;
  }

  historyStep(dir) {
    if (!this.history.length) return;
    if (this.histIndex === -1) { if (dir > 0) return; this.draft = this.buffer; this.histIndex = this.history.length; }
    this.histIndex = Math.max(0, Math.min(this.history.length, this.histIndex + dir));
    this.buffer = this.histIndex === this.history.length ? this.draft : this.history[this.histIndex];
    if (this.histIndex === this.history.length) this.histIndex = -1;
    this.cursor = this.buffer.length;
  }

  // ── Paleta "/" ─────────────────────────────────────────────────
  paletteItems() {
    const b = this.buffer;
    if (this.state !== 'prompt' && this.state !== 'busy') return [];
    if (!b.startsWith('/') || /\s/.test(b) || this.palette.dismissed) return [];
    const q = b.slice(1).toLowerCase();
    const cmds = this.getCommands();
    const starts = cmds.filter((x) => x.name.slice(1).toLowerCase().startsWith(q));
    const contains = cmds.filter((x) => !starts.includes(x) && x.name.toLowerCase().includes(q));
    const items = [...starts, ...contains].slice(0, 6);
    if (items.map((i) => i.name).join() !== this.palette.items.map((i) => i.name).join()) this.palette.sel = 0;
    this.palette.items = items;
    return items;
  }

  // ── Teclado ────────────────────────────────────────────────────
  onKey(s, key) {
    if (this.closed) return;
    const name = key.name;
    if (name === 'paste-start') { this.pasting = true; return; }
    if (name === 'paste-end') { this.pasting = false; drawLive(); return; }
    if (this.state === 'modal' && this.modalHandler) { this.modalHandler(s, key); return; }

    if (this.pasting) {
      if (name === 'return' || name === 'enter') this.insert('\n');
      else if (s && !key.ctrl && !key.meta) this.insert(s.replace(/\r\n?/g, '\n'));
      return; // se dibuja al terminar de pegar
    }

    const busy = this.state === 'busy';
    const items = this.paletteItems();
    if (key.ctrl && name === 'c') {
      if (busy) return this.onInterrupt?.();
      if (this.asking) return this.asking.resolve(null);
      if (this.buffer) { this.buffer = ''; this.cursor = 0; return drawLive(); }
      return this.onExit?.();
    }
    if (name === 'escape') {
      if (items.length) { this.palette.dismissed = true; return drawLive(); }
      if (this.asking) return this.asking.resolve(null);
      if (busy) return this.onInterrupt?.();
      return;
    }
    if (name === 'tab' && key.shift) { this.onModeCycle?.(); return drawLive(); }
    if (key.ctrl && name === 'o') return this.onExpand?.();
    if (key.ctrl && name === 'd' && !this.buffer && this.state === 'prompt') return this.onExit?.();

    if (items.length && (name === 'up' || name === 'down')) {
      const n = items.length;
      this.palette.sel = (this.palette.sel + (name === 'up' ? n - 1 : 1)) % n;
      return drawLive();
    }
    if (items.length && name === 'tab') {
      this.buffer = `${items[this.palette.sel].name} `;
      this.cursor = this.buffer.length;
      return drawLive();
    }

    // nueva línea: alt+enter, ctrl+j o "\" al final
    if ((name === 'return' && key.meta) || (name === 'enter' && s === '\n')) { this.insert('\n'); return drawLive(); }
    if (name === 'return') {
      if (this.buffer.endsWith('\\') && this.cursor === this.buffer.length) { this.buffer = `${this.buffer.slice(0, -1)}\n`; this.cursor = this.buffer.length; return drawLive(); }
      if (items.length) {
        const typed = this.buffer.trim();
        if (!this.getCommands().some((x) => x.name === typed)) { this.buffer = items[this.palette.sel].name; this.cursor = this.buffer.length; }
      }
      return this.submit();
    }

    switch (name) {
      case 'backspace': if (key.ctrl || key.meta) this.deleteBack(this.cursor - this.wordLeft()); else this.deleteBack(); break;
      case 'delete': this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1); break;
      case 'left': this.cursor = key.ctrl || key.meta ? this.wordLeft() : Math.max(0, this.cursor - 1); break;
      case 'right': this.cursor = key.ctrl || key.meta ? this.wordRight() : Math.min(this.buffer.length, this.cursor + 1); break;
      case 'home': this.cursor = this.lineBounds().start; break;
      case 'end': this.cursor = this.lineBounds().end; break;
      case 'up': if (!this.moveVertical(-1)) this.historyStep(-1); break;
      case 'down': if (!this.moveVertical(1)) this.historyStep(1); break;
      default:
        if (key.ctrl) {
          if (name === 'a') this.cursor = this.lineBounds().start;
          else if (name === 'e') this.cursor = this.lineBounds().end;
          else if (name === 'u') { const { start } = this.lineBounds(); this.buffer = this.buffer.slice(0, start) + this.buffer.slice(this.cursor); this.cursor = start; }
          else if (name === 'k') { const { end } = this.lineBounds(); this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(end); }
          else if (name === 'w') this.deleteBack(this.cursor - this.wordLeft());
          else return;
        } else if (s && !key.meta && s >= ' ') this.insert(s);
        else return;
    }
    drawLive();
  }

  submit() {
    const text = this.buffer;
    if (this.asking) {
      this.buffer = '';
      this.cursor = 0;
      return this.asking.resolve(text);
    }
    if (!text.trim()) return drawLive();
    this.buffer = '';
    this.cursor = 0;
    this.histIndex = -1;
    this.saveHistory(text);
    if (this.state === 'busy') { this.queued = text; return drawLive(); }
    if (this.state !== 'prompt' || !this.pending) return drawLive();
    const resolve = this.pending;
    this.pending = null;
    this.state = 'idle';
    this.echo(text);
    resolve(text);
  }

  // ── Dibujo ─────────────────────────────────────────────────────
  layout(innerWidth) {
    // filas visuales: cada línea lógica se parte al ancho disponible
    const text = this.asking?.secret ? '•'.repeat(this.buffer.length) : this.buffer;
    const rows = [];
    let row = '', rowW = 0, rowStart = 0;
    let cur = { r: 0, c: 0 };
    const chars = [...text];
    let idx = 0;
    for (let k = 0; k <= chars.length; k++) {
      if (idx === this.cursor) cur = { r: rows.length, c: rowW };
      if (k === chars.length) break;
      const ch = chars[k];
      if (ch === '\n') { rows.push(row); row = ''; rowW = 0; idx += 1; rowStart = idx; continue; }
      const w = visibleWidth(ch);
      if (rowW + w > innerWidth) { rows.push(row); row = ''; rowW = 0; rowStart = idx; if (idx === this.cursor) cur = { r: rows.length, c: 0 }; }
      row += ch;
      rowW += w;
      idx += ch.length;
    }
    rows.push(row);
    void rowStart;
    return { rows, cur };
  }

  setHidden(h) {
    this.hidden = h;
    drawLive();
  }

  render({ dim }) {
    if (this.hidden) return { lines: [], cursor: null };
    const cols = process.stdout.columns || 80;
    const W = Math.max(24, cols - 1);
    const inner = W - 6; // "│ › " + texto + " │"
    const focus = !dim && (this.state === 'prompt' || this.state === 'ask' || this.state === 'busy');
    const border = (t) => style(t, { fg: focus ? 'accent/primary' : 'border/default' });
    const lines = dim ? [] : ['']; // un renglón de aire entre la conversación y la caja
    if (this.asking?.label) lines.push(` ${c.primary(this.asking.label)}`);
    const { rows, cur } = this.layout(inner);
    let top = 0;
    if (rows.length > MAX_ROWS) top = Math.min(Math.max(0, cur.r - MAX_ROWS + 1), rows.length - MAX_ROWS);
    const visible = rows.slice(top, top + MAX_ROWS);
    const empty = !this.buffer;
    let placeholder = '';
    if (empty) {
      if (this.asking) placeholder = L('Escribe tu respuesta y pulsa enter', 'Type your answer and press enter');
      else if (this.state === 'busy') placeholder = L('Escribe tu siguiente mensaje (se envía al terminar)', 'Type your next message (sent when done)');
      else if (dim) placeholder = L('Responde arriba para continuar', 'Answer above to continue');
      else placeholder = L('Escribe una tarea, / para comandos, @ para archivos', 'Type a task, / for commands, @ for files');
    }
    lines.push(border(`╭${'─'.repeat(W - 2)}╮`));
    const boxTop = lines.length;
    visible.forEach((r, i) => {
      const first = i === 0 && top === 0;
      const lead = first ? (this.asking ? c.accent('?', { bold: true }) : c.accent('›', { bold: true })) : ' ';
      const content = empty && i === 0 ? c.dim(placeholder) : dim ? c.dim(r) : c.primary(r);
      const pad = ' '.repeat(Math.max(0, inner - visibleWidth(empty && i === 0 ? placeholder : r)));
      lines.push(`${border('│')} ${dim ? c.dim(empty ? '›' : '›') : lead} ${content}${pad} ${border('│')}`);
    });
    lines.push(border(`╰${'─'.repeat(W - 2)}╯`));
    // debajo: paleta o barra de estado
    const items = this.paletteItems();
    if (items.length) {
      for (const [i, it] of items.entries()) {
        const sel = i === this.palette.sel;
        const desc = String(it.description || '');
        const row = `${sel ? c.accent('› ', { bold: true }) : '  '}${sel ? c.accent(it.name.padEnd(16), { bold: true }) : c.primary(it.name.padEnd(16))}${sel ? c.primary(desc) : c.muted(desc)}`;
        lines.push(sel ? style(`${row}${' '.repeat(Math.max(0, W - visibleWidth(row)))}`, { bg: 'bg/elevated' }) : row);
      }
    } else if (this.asking) {
      lines.push(c.dim(`  ${L('enter enviar · esc cancelar', 'enter send · esc cancel')}`));
    } else {
      let st = this.getStatus() || '';
      if (this.queued) st += c.warning(`  ·  ${L('1 mensaje en cola', '1 message queued')}`);
      lines.push(st);
    }
    const cursorRow = boxTop + (cur.r - top);
    return { lines, cursor: { row: cursorRow, col: 4 + (empty ? 0 : cur.c) } };
  }
}

export function canUseBox() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && liveActive !== undefined;
}
