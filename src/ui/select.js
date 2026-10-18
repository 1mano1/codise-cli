// Menú navegable con flechas, números 1-9, enter y esc. Accesible: en modo lector de pantalla o sin TTY
// muestra una lista numerada y pide el número.
import { c, style, visibleWidth } from './theme.js';
import { isScreenReader, ensureNewline, println, width } from './output.js';

// options: [{ label, value, hint, hintColor, disabled }]
export async function select(input, { title, options, initial = 0, footer, extra, collapse = true }) {
  if (!options.length) return null;
  if (!input.tty || isScreenReader()) return selectByNumber(input, { title, options });
  ensureNewline();
  let sel = Math.max(0, Math.min(initial, options.length - 1));
  let drawn = 0;
  const out = process.stdout;
  const w = Math.min(width() - 2, 110);

  const render = () => {
    const lines = [];
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
    lines.push(c.dim(footer || '↑↓ elegir · enter confirmar · 1-9 directo · esc cancelar'));
    if (drawn) out.write(`\x1b[${drawn}A\r\x1b[J`);
    out.write(`${lines.join('\n')}\n`);
    drawn = lines.length;
  };

  return new Promise((resolve) => {
    let release;
    const finish = (value) => {
      release();
      if (collapse) {
        out.write(`\x1b[${drawn}A\r\x1b[J`);
        const chosen = value == null ? c.dim('cancelado') : style(options[sel].label, { fg: 'accent/soft', bold: true });
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
  if (title) println(title.replace(/\x1b\[[0-9;]*m/g, ''));
  options.forEach((o, i) => println(`  ${i + 1}. ${o.label}${o.hint ? ` (${o.hint})` : ''}`));
  const a = await input.question('Escribe el número de tu opción (vacío para cancelar): ');
  const n = Number(String(a ?? '').trim());
  if (!n || n < 1 || n > options.length) return null;
  return options[n - 1].value;
}

export async function confirm(input, question, { yes = 'Sí', no = 'No' } = {}) {
  const v = await select(input, { title: question, options: [{ label: yes, value: true }, { label: no, value: false }] });
  return v === true;
}
