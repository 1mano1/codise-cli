// Menú navegable con flechas, números 1-9, enter y esc. Accesible: en modo lector de pantalla o sin TTY
// muestra una lista numerada y pide el número.
import { c, style, visibleWidth } from './theme.js';
import { isScreenReader, ensureNewline, println, width, fit } from './output.js';
import { L } from '../i18n.js';

// options: [{ label, value, hint, hintColor, disabled }]
export async function select(input, { title, options, initial = 0, footer, extra, collapse = true, erase = false, pre = [], onChange }) {
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

  const render = () => {
    onChange?.(options[sel], sel);
    const lines = [...pre];
    if (title) lines.push(title);
    options.forEach((o, i) => {
      const isSel = i === sel;
      const num = i < 9 ? `${i + 1}.` : '  ';
      let line = `${isSel ? c.accent('› ', { bold: true }) : '  '}${isSel ? c.accent(num) : c.dim(num)} ${isSel ? style(o.label, { bold: true, fg: 'text/primary' }) : o.disabled ? c.dim(o.label) : c.muted(o.label)}`;
      if (o.hint) line += `  ${style(o.hint, { fg: o.hintColor || 'text/dim' })}`;
      if (isSel) {
        const pad = Math.max(0, w - visibleWidth(line));
        line = style(line + ' '.repeat(pad), { bg: 'bg/elevated' });
      }
      lines.push(line);
    });
    if (extra) for (const l of extra(options[sel], sel) || []) lines.push(l);
    lines.push(c.dim(footer || L('↑↓ elegir · enter confirmar · esc cancelar', '↑↓ move · enter select · esc cancel')));
    if (drawn) out.write(`\x1b[${drawn}A\r\x1b[J`);
    // cada línea debe caber en un renglón: si se partiera, el redibujado se descuadra
    const safe = lines.map((l) => fit(l, Math.max(20, (process.stdout.columns || 80) - 1)));
    out.write(`${safe.join('\n')}\n`);
    drawn = safe.length;
  };

  return new Promise((resolve) => {
    let release;
    const finish = (value) => {
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
