// Mascotas: carga (incluidas y propias), estados y render con medios bloques ▀▄.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, HOME } from '../config.js';
import { readJSON, writeJSON, listDirs } from '../util/fs.js';
import { style, colorLevel, currentTheme } from './theme.js';
import { L } from '../i18n.js';

export function loadMascots() {
  const builtin = readJSON(path.join(ROOT, 'design', 'mascots.json'), {});
  delete builtin.$comment;
  const out = {};
  for (const [id, m] of Object.entries(builtin)) out[id] = { ...m, id, builtin: true };
  const dir = path.join(HOME, 'mascots');
  for (const d of listDirs(dir)) {
    const m = readJSON(path.join(dir, d, 'mascot.json'));
    const err = validateMascot(m);
    if (!err) out[d] = { ...m, id: d, custom: true };
  }
  return out;
}

export function validateMascot(m) {
  if (!m || typeof m !== 'object') return L('mascot.json vacío o inválido', 'mascot.json is empty or invalid');
  if (!Array.isArray(m.pixels) || !m.pixels.length) return L('falta "pixels" (lista de filas)', 'missing "pixels" (list of rows)');
  if (!m.palette || typeof m.palette !== 'object') return L('falta "palette"', 'missing "palette"');
  const w = m.pixels[0].length;
  if (m.pixels.some((r) => r.length !== w)) return L('todas las filas de "pixels" deben medir lo mismo', 'all "pixels" rows must have the same length');
  if (w > 32 || m.pixels.length > 32) return L('máximo 32×32 píxeles', 'maximum 32×32 pixels');
  for (const row of m.pixels) for (const ch of row) if (ch !== '.' && !m.palette[ch]) return L(`el carácter "${ch}" no está en la paleta`, `character "${ch}" is not in the palette`);
  return null;
}

export function saveCustomMascot(id, mascot) {
  const file = path.join(HOME, 'mascots', id, 'mascot.json');
  writeJSON(file, mascot);
  return file;
}

// auto → mascota propia que declare el tema, o la del tema, o Xolo.
// auto → la elegida para este tema (themeMascots), una propia que declare el tema, la del tema o Xolo.
export function resolveMascot(settings, mascots) {
  const sel = settings.mascot?.name || 'auto';
  if (sel === 'none' || sel === 'ninguna') return null;
  if (sel !== 'auto' && mascots[sel]) return mascots[sel];
  const theme = currentTheme();
  const perTheme = settings.themeMascots?.[theme.id];
  if (perTheme === 'none') return null;
  if (perTheme && mascots[perTheme]) return mascots[perTheme];
  const custom = Object.values(mascots).find((m) => m.custom && (m.themes || []).includes(theme.id));
  return custom || mascots[theme.mascot] || mascots.xolo || null;
}

function bodyColor(m) {
  const counts = {};
  for (const row of m.pixels) for (const ch of row) if (ch !== '.' && ch !== m.eyes && ch !== m.mouth) counts[ch] = (counts[ch] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top ? m.palette[top[0]] : '#888888';
}

// Estados derivados de los ojos y la boca: idle, blink, thinking, success, error.
export function mascotPalette(m, state = 'idle') {
  const pal = { ...m.palette };
  if (!m.eyes || !pal[m.eyes]) return pal;
  if (state === 'blink') pal[m.eyes] = bodyColor(m);
  else if (state === 'thinking') pal[m.eyes] = m.mouth && pal[m.mouth] ? pal[m.mouth] : bodyColor(m);
  else if (state === 'error') pal[m.eyes] = '#E0303A';
  return pal;
}

export function renderMascot(m, state = 'idle') {
  if (!m || colorLevel() === 0) return [];
  const pal = mascotPalette(m, state);
  const rows = [...m.pixels];
  if (rows.length % 2) rows.push('.'.repeat(rows[0].length));
  const lines = [];
  for (let y = 0; y < rows.length; y += 2) {
    let line = '';
    for (let x = 0; x < rows[y].length; x++) {
      const top = rows[y][x], bot = rows[y + 1][x];
      if (top === '.' && bot === '.') line += ' ';
      else if (bot === '.') line += style('▀', { fg: pal[top] });
      else if (top === '.') line += style('▄', { fg: pal[bot] });
      else line += style('▀', { fg: pal[top], bg: pal[bot] });
    }
    lines.push(line);
  }
  return lines;
}

export function mascotVerbs(m, settings) {
  if (settings.spinnerVerbs?.length) return settings.spinnerVerbs;
  if (m?.verbs?.length) return m.verbs;
  return L(['Pensando…', 'Trabajando…', 'Analizando…'], ['Thinking…', 'Working…', 'Analyzing…']);
}
