// Motor de temas: carga design/themes.json, temas personalizados, degrada colores según la terminal.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { L } from '../i18n.js';

const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'design', 'themes.json'), 'utf8'));
delete raw.$comment;
export const BUILTIN_THEMES = raw;
export const TOKENS = Object.keys(raw.brasa.tokens);

// 0 = sin color, 1 = 16 colores, 2 = 256, 3 = truecolor
export function detectColorLevel() {
  const env = process.env;
  if ('NO_COLOR' in env || env.TERM === 'dumb') return 0;
  if (env.FORCE_COLOR !== undefined) {
    const n = Number(env.FORCE_COLOR);
    return Number.isNaN(n) ? 1 : Math.max(0, Math.min(3, n));
  }
  if (!process.stdout.isTTY) return 0;
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit' || env.WT_SESSION || env.TERM_PROGRAM === 'vscode') return 3;
  if (process.platform === 'win32') return 3;
  if (/256/.test(env.TERM || '')) return 2;
  return 1;
}

const state = {
  id: 'brasa',
  theme: BUILTIN_THEMES.brasa,
  level: detectColorLevel(),
};

export function colorLevel() {
  return state.level;
}

export function setColorLevel(level) {
  state.level = level;
}

export function currentTheme() {
  return { id: state.id, ...state.theme };
}

const EN_NAMES = {
  brasa: 'Ember (dark)', alba: 'Dawn (light)', medianoche: 'Midnight', daltonico: 'Color-blind',
  'alto-contraste': 'High contrast', fosforo: 'Phosphor (retro)',
};

export function allThemes(customThemes = {}) {
  const out = {};
  for (const [id, t] of Object.entries(BUILTIN_THEMES)) out[id] = { ...t, name: L(t.name, EN_NAMES[id] || t.name) };
  for (const [id, c] of Object.entries(customThemes || {})) out[id] = buildCustom(id, c);
  return out;
}

function buildCustom(id, c) {
  const base = BUILTIN_THEMES[c.base] || BUILTIN_THEMES.brasa;
  const tokens = { ...base.tokens };
  for (const [k, v] of Object.entries(c.tokens || c)) if (TOKENS.includes(k) && /^#[0-9a-f]{6}$/i.test(v)) tokens[k] = v;
  return { name: c.name || id, appearance: c.appearance || base.appearance, mascot: c.mascot || base.mascot, tokens, custom: true };
}

// Detecta si la terminal tiene fondo claro (COLORFGBG="fg;bg", usado por muchas terminales).
export function detectAppearance() {
  const v = process.env.COLORFGBG;
  if (v) {
    const bg = Number(v.split(';').pop());
    if (!Number.isNaN(bg)) return bg === 7 || bg === 15 || (bg >= 9 && bg <= 14) ? 'light' : 'dark';
  }
  if (process.env.CODICE_APPEARANCE === 'light') return 'light';
  return 'dark';
}

export function setTheme(id, customThemes = {}) {
  const themes = allThemes(customThemes);
  if (id === 'auto' || !id) id = detectAppearance() === 'light' ? 'alba' : 'brasa';
  const t = themes[id] || themes.brasa;
  state.id = themes[id] ? id : 'brasa';
  state.theme = t;
  return { id: state.id, ...t, warnings: validateContrast(t.tokens) };
}

// ── Contraste (WCAG) ─────────────────────────────────────────────
export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function luminance([r, g, b]) {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a, b) {
  const A = luminance(hexToRgb(a)), B = luminance(hexToRgb(b));
  return (Math.max(A, B) + 0.05) / (Math.min(A, B) + 0.05);
}

const TEXT_TOKENS = ['text/primary', 'text/muted', 'text/dim', 'accent/primary', 'accent/soft', 'status/success', 'status/error', 'status/warning', 'status/info', 'status/agent'];

export function validateContrast(tokens) {
  const warnings = [];
  for (const fg of TEXT_TOKENS) {
    for (const bg of ['bg/base', 'bg/surface', 'bg/elevated']) {
      const r = contrast(tokens[fg], tokens[bg]);
      if (r < 4.5) warnings.push(L(`${fg} sobre ${bg}: ${r.toFixed(2)}:1 (mínimo 4.5:1)`, `${fg} on ${bg}: ${r.toFixed(2)}:1 (minimum 4.5:1)`));
    }
  }
  return warnings;
}

// ── Conversión a ANSI ────────────────────────────────────────────
const BASIC16 = [
  [0, 0, 0], [205, 49, 49], [13, 188, 121], [229, 229, 16], [36, 114, 200], [188, 63, 188], [17, 168, 205], [229, 229, 229],
  [102, 102, 102], [241, 76, 76], [35, 209, 139], [245, 245, 67], [59, 142, 234], [214, 112, 214], [41, 184, 219], [255, 255, 255],
];

function nearest16(rgb) {
  let best = 0, bd = Infinity;
  BASIC16.forEach((c, i) => {
    const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

function to256([r, g, b]) {
  if (Math.abs(r - g) < 10 && Math.abs(g - b) < 10) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const q = (v) => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

function sgrColor(hex, isBg) {
  const rgb = hexToRgb(hex);
  if (state.level >= 3) return `${isBg ? 48 : 38};2;${rgb[0]};${rgb[1]};${rgb[2]}`;
  if (state.level === 2) return `${isBg ? 48 : 38};5;${to256(rgb)}`;
  const n = nearest16(rgb);
  return String((isBg ? 40 : 30) + (n % 8) + (n >= 8 ? 60 : 0));
}

export function tokenHex(token) {
  return state.theme.tokens[token] || token;
}

// style('texto', { fg: 'accent/primary', bg: 'diff/add-bg', bold, italic, strike })
export function style(text, o = {}) {
  text = String(text ?? '');
  if (state.level === 0 || !text) return text;
  const codes = [];
  if (o.bold) codes.push('1');
  if (o.italic) codes.push('3');
  if (o.strike) codes.push('9');
  if (o.fg) codes.push(sgrColor(o.fg.startsWith('#') ? o.fg : tokenHex(o.fg), false));
  if (o.bg) codes.push(sgrColor(o.bg.startsWith('#') ? o.bg : tokenHex(o.bg), true));
  if (!codes.length) return text;
  return `\x1b[${codes.join(';')}m${text}\x1b[0m`;
}

// Atajos: c.accent('x'), c.dim('x', {italic:true})…
const mk = (token) => (text, o = {}) => style(text, { ...o, fg: token });
export const c = {
  primary: mk('text/primary'),
  muted: mk('text/muted'),
  dim: mk('text/dim'),
  accent: mk('accent/primary'),
  soft: mk('accent/soft'),
  success: mk('status/success'),
  error: mk('status/error'),
  warning: mk('status/warning'),
  info: mk('status/info'),
  agent: mk('status/agent'),
  border: mk('border/default'),
  bold: (t) => style(t, { bold: true }),
};

export function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[78]/g, '');
}

export function visibleWidth(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const cp = ch.codePointAt(0);
    // caracteres anchos (CJK, emoji) ocupan 2 columnas
    w += (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0x1f300 && cp <= 0x1faff))) ? 2 : 1;
  }
  return w;
}
