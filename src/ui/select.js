// Menú navegable con flechas, números 1-9, enter y esc. Accesible: en modo lector de pantalla o sin TTY
// muestra una lista numerada y pide el número.
import { c, style, visibleWidth } from './theme.js';
import { isScreenReader, ensureNewline, println, width, fit } from './output.js';
import { L } from '../i18n.js';
import { liveActive, setOverlay, drawLive } from './live.js';

// options: [{ label, value, hint, hintColor, disabled }]
export async function select(input, { title, options, initial = 0, footer, extra, collapse = true, erase = false, pre = [], onChange, tone = null }) {
  if (!options.length) return null;
  if (!input?.tty || isScreenReader()) {
    for (const l of pre) println(l.replace(/\x1b\[[0-9;]*m/g, ''));
    return selectByNumber(input, { title, options });
  }
  ensureNewline();
  let sel = Math.max(0, Math.min(initial, options.length - 1));
  let drawn = 0;
  const out = process.stdout;
  const w = Math.min(width() - 2, 110);

  const live = liveActive();
  const render = () => {
    onChange?.(options[sel], sel);
    const lines = [...pre];
    if (title) lines.push(title);
    // con la caja de entrada activa, el menú es un diálogo encima de ella: se limita su alto a la pantalla
    let first = 0, last = options.length;
    if (live) {
      const room = Math.max(5, (process.stdout.rows || 30) - 9 - lines.length - (extra ? (extra(options[sel], sel) || []).length : 0));
      if (options.length > room) {
        first = Math.min(Math.max(0, sel - Math.floor(room / 2)), options.length - room);
        last = first + room;
      }
    }
    options.forEach((o, i) => {
      if (i < first || i >= last) return;
      const isSel = i === sel;
      const num = i < 9 ? `${i + 1}.` : '  ';
      let line = `${isSel ? c.accent('› ', { bold: true }) : '  '}${isSel ? c.accent(num) : c.dim(num)} ${isSel ? style(o.label, { bold: true, fg: 'text/primary' }) : o.disabled ? c.dim(o.label) : c.muted(o.label)}`;
      if (o.hint) line += `  ${style(o.hint, { fg: o.hintColor || 'text/dim' })}`;
      if (isSel) {
        // dentro del diálogo, el resaltado llega justo al borde interior (sin cortar)
        const target = live ? Math.max(20, (process.stdout.columns || 80) - 5) : w;
        const pad = Math.max(0, target - visibleWidth(line));
        line = style(line + ' '.repeat(pad), { bg: 'bg/elevated' });
      }
      lines.push(line);
    });
    if (live && (first > 0 || last < options.length)) lines.push(c.dim(`   ${first > 0 ? '↑ ' : ''}${last < options.length ? '↓ ' : ''}${L(`${options.length} opciones`, `${options.length} options`)}`));
    if (extra) for (const l of extra(options[sel], sel) || []) lines.push(l);
    lines.push(c.dim(footer || L('↑↓ elegir · enter confirmar · esc cancelar', '↑↓ move · enter select · esc cancel')));
    if (live) {
      const W = Math.max(24, (process.stdout.columns || 80) - 1);
      const b = (s) => style(s, { fg: tone || 'border/default' });
      const inner = W - 4;
      setOverlay([
        b(`╭${'─'.repeat(W - 2)}╮`),
        ...lines.map((l) => { const f = fit(l, inner); return `${b('│')} ${f}${' '.repeat(Math.max(0, inner - visibleWidth(f)))} ${b('│')}`; }),
        b(`╰${'─'.repeat(W - 2)}╯`),
      ]);
      drawLive();
      return;
    }
    if (drawn) out.write(`\x1b[${drawn}A\r\x1b[J`);
    // cada línea debe caber en un renglón: si se partiera, el redibujado se descuadra
    const safe = lines.map((l) => fit(l, Math.max(20, (process.stdout.columns || 80) - 1)));
    out.write(`${safe.join('\n')}\n`);
    drawn = safe.length;
  };

  return new Promise((resolve) => {
    let release;
    const finish = (value) => {
      if (live) {
        setOverlay(null);
        release();
        if (!erase && collapse && title) {
          const chosen = value == null ? c.dim(L('cancelado', 'cancelled')) : style(options[sel].label, { fg: 'accent/soft', bold: true });
          println(`${title} ${c.dim('→')} ${chosen}`);
        }
        resolve(value);
        return;
      }
      release();
      if (erase) out.write(`\x1b[${drawn}A\r\x1b[J`);
      else if (collapse) {
        out.write(`\x1b[${drawn}A\r\x1b[J`);
        const chosen = value == null ? c.dim(L('cancelado', 'cancelled')) : style(options[sel].label, { fg: 'accent/soft', bold: true });
        if (title) println(`${title} ${c.dim('→')} ${chosen}`);
      }
      resolve(value);
    };
    release = input.modal((s, key = {}) => {
      const n = key.name;
      if (n === 'up' || n === 'k') { do { sel = (sel + options.length - 1) % options.length; } while (options[sel].disabled); render(); }
      else if (n === 'down' || n === 'j') { do { sel = (sel + 1) % options.length; } while (options[sel].disabled); render(); }
      else if (n === 'return' || n === 'enter') { if (!options[sel].disabled) finish(options[sel].value); }
      else if (n === 'escape' || (key.ctrl && n === 'c')) finish(null);
      else if (s && /^[1-9]$/.test(s) && Number(s) <= options.length && !options[Number(s) - 1].disabled) { sel = Number(s) - 1; render(); finish(options[sel].value); }
    });
    render();
  });
}

// Panel informativo encima de la caja (p. ej. /usage): no queda en la conversación; esc lo cierra y ↑↓ desplaza.
export async function showPanel(input, { title, text, tone = 'accent/primary' }) {
  const body = String(text).replace(/\n+$/, '').split('\n');
  if (!body.some((l) => l.trim())) return;
  let first = 0;
  const render = () => {
    const W = Math.max(24, (process.stdout.columns || 80) - 1);
    const inner = W - 4;
    const room = Math.max(3, (process.stdout.rows || 30) - 9);
    const max = Math.max(0, body.length - room);
    first = Math.max(0, Math.min(first, max));
    const shown = body.slice(first, first + room);
    const b = (s) => style(s, { fg: tone });
    const row = (l) => { const f = fit(l, inner); return `${b('│')} ${f}${' '.repeat(Math.max(0, inner - visibleWidth(f)))} ${b('│')}`; };
    const label = ` ${title} `;
    const more = max ? `  ${first > 0 ? '↑' : ' '}${first < max ? '↓' : ' '} ${first + 1}-${first + shown.length}/${body.length}` : '';
    setOverlay([
      `${b('╭─')}${style(label, { fg: 'accent/primary', bold: true })}${b(`${'─'.repeat(Math.max(0, W - 3 - visibleWidth(label)))}╮`)}`,
      ...shown.map(row),
      row(''),
      row(c.dim(`${L('esc cerrar', 'esc close')}${max ? L(' · ↑↓ desplazar', ' · ↑↓ scroll') : ''}${more}`)),
      b(`╰${'─'.repeat(W - 2)}╯`),
    ]);
    drawLive();
  };
  return new Promise((resolve) => {
    const release = input.modal((s, key = {}) => {
      const n = key.name;
      const page = Math.max(3, (process.stdout.rows || 30) - 10);
      if (n === 'escape' || n === 'return' || n === 'enter' || n === 'q' || (key.ctrl && n === 'c')) {
        setOverlay(null);
        release();
        drawLive();
        resolve();
        return;
      }
      if (n === 'up' || n === 'k') first--;
      else if (n === 'down' || n === 'j') first++;
      else if (n === 'pageup') first -= page;
      else if (n === 'pagedown' || n === 'space') first += page;
      else if (n === 'home') first = 0;
      else if (n === 'end') first = body.length;
      else return;
      render();
    });
    render();
  });
}

async function selectByNumber(input, { title, options }) {
  ensureNewline();
  if (!input) return null;
  if (title) println(title.replace(/\x1b\[[0-9;]*m/g, ''));
  options.forEach((o, i) => println(`  ${i + 1}. ${o.label}${o.hint ? ` (${o.hint})` : ''}`));
  const a = await input.question(L('Escribe el número de tu opción (vacío para cancelar): ', 'Type the number of your choice (empty to cancel): '));
  const n = Number(String(a ?? '').trim());
  if (!n || n < 1 || n > options.length) return null;
  return options[n - 1].value;
}

export async function confirm(input, question, { yes = L('Sí', 'Yes'), no = 'No' } = {}) {
  const v = await select(input, { title: question, options: [{ label: yes, value: true }, { label: no, value: false }] });
  return v === true;
}
