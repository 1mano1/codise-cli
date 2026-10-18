// Entrada interactiva: prompt con paleta "/" en vivo, barra de estado, atajos y modo modal para menús.
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { c, style, visibleWidth } from './theme.js';
import { isScreenReader, width, fit } from './output.js';

const MAX_HISTORY = 500;

export class Input {
  constructor({ historyFile, getCommands = () => [], getStatus = () => '', onModeCycle, onInterrupt, onExpand, onExit } = {}) {
    this.historyFile = historyFile;
    this.getCommands = getCommands;
    this.getStatus = getStatus;
    this.onModeCycle = onModeCycle;
    this.onInterrupt = onInterrupt;
    this.onExpand = onExpand;
    this.onExit = onExit;
    this.tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    this.state = 'idle'; // idle | prompt | busy | modal | question
    this.typeahead = '';
    this.palette = { open: false, items: [], sel: 0, dismissed: false };
    this.belowRows = 0;
    this.modalHandler = null;
    this.closed = false;
    this.lineQueue = [];
    this.lineWaiters = [];
  }

  start() {
    const history = this.loadHistory();
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: this.tty,
      history,
      historySize: MAX_HISTORY,
      removeHistoryDuplicates: true,
      tabSize: 2,
    });
    this.rl.on('close', () => {
      this.closed = true;
      for (const w of this.lineWaiters.splice(0)) w(null);
      if (this.pendingQuestion) { const r = this.pendingQuestion; this.pendingQuestion = null; r(null); }
    });
    if (!this.tty) {
      // modo tubería: cola de líneas
      this.rl.on('line', (l) => {
        if (this.pendingQuestion) { const r = this.pendingQuestion; this.pendingQuestion = null; r(l); }
        else if (this.lineWaiters.length) this.lineWaiters.shift()(l);
        else this.lineQueue.push(l);
      });
      return;
    }
    const orig = this.rl._ttyWrite.bind(this.rl);
    this.rl._ttyWrite = (s, key = {}) => this.handleKey(s, key, orig);
    this.rl.on('SIGINT', () => {}); // gestionado en handleKey
  }

  loadHistory() {
    try {
      return fs.readFileSync(this.historyFile, 'utf8').split('\n').filter(Boolean).reverse().slice(0, MAX_HISTORY);
    } catch {
      return [];
    }
  }

  saveHistory(line) {
    if (!this.historyFile || !line.trim()) return;
    try {
      fs.mkdirSync(path.dirname(this.historyFile), { recursive: true });
      fs.appendFileSync(this.historyFile, `${line.replace(/\n/g, ' ')}\n`);
    } catch { /* sin historial */ }
  }

  // ── Manejo de teclas ───────────────────────────────────────────
  handleKey(s, key, orig) {
    const name = key.name;
    if (this.state === 'modal' && this.modalHandler) { this.modalHandler(s, key); return; }
    if (this.state === 'busy') {
      if (name === 'escape' || (key.ctrl && name === 'c')) this.onInterrupt?.();
      else if (key.ctrl && name === 'o') this.onExpand?.();
      else if (s && !key.ctrl && !key.meta && name !== 'return' && name !== 'enter' && name !== 'escape') this.typeahead += s;
      return;
    }
    if (this.state === 'question') {
      if (key.ctrl && name === 'c') { this.rl.write(null, { ctrl: true, name: 'u' }); orig('\r', { name: 'return' }); return; }
      orig(s, key);
      return;
    }
    if (this.state !== 'prompt') { orig(s, key); return; }

    // estado prompt
    if (key.ctrl && name === 'c') {
      if (this.rl.line) { this.rl.write(null, { ctrl: true, name: 'u' }); this.refreshBelow(); return; }
      this.onExit?.();
      return;
    }
    if (name === 'tab' && key.shift) { this.onModeCycle?.(); this.refreshBelow(); return; }
    if (key.ctrl && name === 'o') { this.onExpand?.(); return; }
    if (this.palette.open) {
      if (name === 'up' || name === 'down') {
        const n = this.palette.items.length;
        this.palette.sel = (this.palette.sel + (name === 'up' ? n - 1 : 1)) % n;
        this.refreshBelow();
        return;
      }
      if (name === 'tab') { this.completePalette(); return; }
      if (name === 'escape') { this.palette.dismissed = true; this.refreshBelow(); return; }
      if (name === 'return' || name === 'enter') {
        const item = this.palette.items[this.palette.sel];
        const typed = this.rl.line.trim();
        if (item && typed !== item.name && !this.getCommands().some((x) => x.name === typed)) this.setLine(item.name);
      }
    }
    if (name === 'return' || name === 'enter') { this.clearBelow(); orig(s, key); return; }
    if (name === 'escape') return;
    orig(s, key);
    if (this.palette.dismissed && !this.rl.line.startsWith('/')) this.palette.dismissed = false;
    this.refreshBelow();
  }

  setLine(text) {
    this.rl.write(null, { ctrl: true, name: 'u' });
    this.rl.write(null, { ctrl: true, name: 'k' });
    this.rl.write(text);
  }

  completePalette() {
    const item = this.palette.items[this.palette.sel];
    if (item) this.setLine(`${item.name} `);
    this.refreshBelow();
  }

  // ── Zona bajo el prompt (paleta o barra de estado) ─────────────
  computePalette() {
    const line = this.rl.line || '';
    if (!line.startsWith('/') || line.includes(' ') || this.palette.dismissed) return [];
    const q = line.slice(1).toLowerCase();
    const cmds = this.getCommands();
    const starts = cmds.filter((x) => x.name.slice(1).toLowerCase().startsWith(q));
    const contains = cmds.filter((x) => !starts.includes(x) && x.name.toLowerCase().includes(q));
    return [...starts, ...contains].slice(0, 8);
  }

  belowLines() {
    const items = this.computePalette();
    const wasOpen = this.palette.open;
    this.palette.open = items.length > 0;
    if (!this.palette.open) { this.palette.items = []; this.palette.sel = 0; }
    else {
      if (!wasOpen || items.map((i) => i.name).join() !== this.palette.items.map((i) => i.name).join()) this.palette.sel = 0;
      this.palette.items = items;
    }
    if (this.palette.open) {
      const w = width() - 2;
      return items.map((it, i) => {
        const sel = i === this.palette.sel;
        const label = it.label || it.source || '';
        const src = it.source === 'integrado' ? c.dim(label) : it.source === 'skill' ? c.agent(label) : c.info(label);
        const name = sel ? c.accent(it.name.padEnd(20), { bold: true }) : c.primary(it.name.padEnd(20));
        const desc = (it.description || '').slice(0, Math.max(10, w - 44));
        const line = `${sel ? c.accent('› ', { bold: true }) : '  '}${name}${sel ? c.primary(desc.padEnd(Math.max(10, w - 44))) : c.muted(desc.padEnd(Math.max(10, w - 44)))} ${src}`;
        return sel ? style(stripPad(line, w), { bg: 'bg/elevated' }) : line;
      });
    }
    const st = this.getStatus();
    return st ? [st] : [];
  }

  renderBelow(lines) {
    const out = process.stdout;
    const n = lines.length;
    const pos = this.rl.getCursorPos();
    // reservar espacio (puede desplazar la pantalla) y volver a la columna del cursor
    out.write('\n'.repeat(n + 0) + (n ? `\x1b[${n}A` : ''));
    readline.cursorTo(out, pos.cols);
    out.write('\x1b7');
    out.write('\x1b[1B\r\x1b[J');
    out.write(lines.map((l) => fit(l, Math.max(20, (out.columns || 80) - 1))).join('\n'));
    out.write('\x1b8');
    this.belowRows = n;
  }

  refreshBelow() {
    if (!this.tty || this.state !== 'prompt' || isScreenReader()) return;
    const lines = this.belowLines();
    if (!lines.length && !this.belowRows) return;
    if (!lines.length) { this.clearBelow(); return; }
    this.renderBelow(lines);
  }

  clearBelow() {
    if (!this.belowRows) return;
    process.stdout.write('\x1b7\x1b[1B\r\x1b[J\x1b8');
    this.belowRows = 0;
  }

  // ── API pública ────────────────────────────────────────────────
  async prompt(promptText) {
    if (!this.tty) {
      process.stdout.write(promptText);
      if (this.lineQueue.length) return this.lineQueue.shift();
      if (this.closed) return null;
      return new Promise((r) => this.lineWaiters.push(r));
    }
    if (this.closed) return null;
    this.state = 'prompt';
    this.palette = { open: false, items: [], sel: 0, dismissed: false };
    const answer = await new Promise((resolve) => {
      this.pendingQuestion = resolve;
      this.rl.question(promptText, (a) => { this.pendingQuestion = null; resolve(a); });
      if (this.typeahead) { this.rl.write(this.typeahead); this.typeahead = ''; }
      this.refreshBelow();
    });
    this.clearBelow();
    this.state = 'idle';
    if (answer != null) this.saveHistory(answer);
    return answer;
  }

  // Pregunta de texto libre (sin paleta ni barra de estado).
  async question(q) {
    if (!this.tty) {
      process.stdout.write(q);
      if (this.lineQueue.length) return this.lineQueue.shift();
      if (this.closed) return null;
      return new Promise((r) => { this.pendingQuestion = r; });
    }
    const prev = this.state;
    this.state = 'question';
    const a = await new Promise((resolve) => {
      this.pendingQuestion = resolve;
      this.rl.question(q, (x) => { this.pendingQuestion = null; resolve(x); });
    });
    this.state = prev === 'busy' ? 'busy' : 'idle';
    return a;
  }

  // Texto oculto (API keys, tokens): muestra • por cada carácter.
  async secret(q) {
    if (!this.tty) return this.question(q);
    process.stdout.write(q);
    return new Promise((resolve) => {
      let value = '';
      const release = this.modal((s, key = {}) => {
        if (key.name === 'return' || key.name === 'enter') { release(); process.stdout.write('\n'); resolve(value); }
        else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) { release(); process.stdout.write('\n'); resolve(null); }
        else if (key.name === 'backspace') { if (value) { value = value.slice(0, -1); process.stdout.write('\b \b'); } }
        else if (s && !key.ctrl && !key.meta) { const clean = s.replace(/[\r\n]/g, ''); value += clean; process.stdout.write('•'.repeat(clean.length)); }
      });
    });
  }

  setBusy(b) {
    if (!this.tty) return;
    this.state = b ? 'busy' : 'idle';
  }

  // Toma el control del teclado. handler(s, key) ; devuelve función para liberar.
  modal(handler) {
    const prev = this.state;
    this.state = 'modal';
    this.modalHandler = handler;
    return () => {
      this.modalHandler = null;
      this.state = prev === 'modal' ? 'idle' : prev;
    };
  }

  close() {
    try { this.rl?.close(); } catch { /* ya cerrado */ }
  }
}

function stripPad(line, w) {
  const vw = visibleWidth(line);
  return vw < w ? line + ' '.repeat(w - vw) : line;
}
