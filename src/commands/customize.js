// Personalización: /theme, /mascot, /accessibility y el panel /config.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HOME } from '../config.js';
import { c, style, allThemes, setTheme, currentTheme, validateContrast, TOKENS } from '../ui/theme.js';
import { renderMascot, saveCustomMascot, validateMascot, loadMascots, resolveMascot, mascotErrors } from '../ui/mascot.js';
import * as ui from '../ui/output.js';
import { select } from '../ui/select.js';
import { liveActive } from '../ui/live.js';
import { pngToMascot } from '../util/png.js';
import { resolvePath } from '../util/fs.js';
import { MODES, MODE_INFO } from '../permissions.js';
import { L, setLanguage } from '../i18n.js';

function samplePreview() {
  return [
    `  ${c.accent('›', { bold: true })} ${c.primary(L('arregla el bug del login', 'fix the login bug'))}`,
    `  ${c.success('●', { bold: true })} ${style('Edit', { bold: true, fg: 'text/primary' })}${c.muted('(src/auth.ts)')}  ${c.dim(L('└ 1 cambio · +1 −1', '└ 1 change · +1 −1'))}`,
    `  ${style('- if (user = null)   ', { fg: 'text/primary', bg: 'diff/del-bg' })}  ${style('+ if (user === null) ', { fg: 'text/primary', bg: 'diff/add-bg' })}`,
    `  ${c.warning(L('⚠ aviso', '⚠ warning'))}  ${c.error('✗ error')}  ${c.agent(L('↳ subagente', '↳ subagent'))}  ${c.info('◆ mcp')}`,
  ];
}

function openInEditor(file) {
  const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'nano');
  spawn(editor, [file], { stdio: 'inherit', shell: process.platform === 'win32', detached: process.platform === 'win32' });
}

async function customThemeWizard({ runtime, repl }) {
  const themes = allThemes(runtime.settings.customThemes);
  const base = await select(repl.input, { title: L('Tema base', 'Base theme'), options: Object.entries(themes).filter(([, t]) => !t.custom).map(([id, t]) => ({ label: t.name, value: id })) });
  if (!base) return;
  const name = (await repl.input.question(`${c.accent('›')} ${L('Nombre del tema', 'Theme name')}: `))?.trim() || 'mi-tema';
  const id = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const tokens = {};
  ui.hint(L('Colores en formato #RRGGBB (enter para dejar el del tema base).', 'Colors as #RRGGBB (enter to keep the base theme color).'));
  for (const tk of ['accent/primary', 'accent/soft', 'bg/surface']) {
    const v = (await repl.input.question(`${c.accent('›')} ${tk} ${c.dim(`(${themes[base].tokens[tk]})`)}: `))?.trim();
    if (/^#[0-9a-f]{6}$/i.test(v || '')) tokens[tk] = v.toUpperCase();
  }
  const warnings = validateContrast({ ...themes[base].tokens, ...tokens });
  runtime.save(`customThemes.${id}`, { name, base, tokens });
  runtime.save('theme', id);
  ui.success(L(`Tema "${name}" creado y activado.`, `Theme "${name}" created and applied.`));
  ui.hint(L(`Más tokens en ${path.join(HOME, 'settings.json')} (customThemes.${id}.tokens). Disponibles: ${TOKENS.join(', ')}`, `More tokens in ${path.join(HOME, 'settings.json')} (customThemes.${id}.tokens). Available: ${TOKENS.join(', ')}`));
  if (warnings.length) {
    ui.warn(L('Algunos colores no alcanzan el contraste mínimo (4.5:1):', 'Some colors do not meet the minimum contrast (4.5:1):'));
    for (const w of warnings.slice(0, 6)) ui.println(`  ${c.warning('·')} ${w}`);
  } else ui.success(L('Contraste verificado: todo el texto cumple WCAG AA.', 'Contrast checked: all text meets WCAG AA.'));
}

async function themeCommand(args, ctx) {
  const { runtime, repl } = ctx;
  const themes = allThemes(runtime.settings.customThemes);
  const mascots = loadMascots();
  const original = runtime.settings.theme || 'auto';
  const direct = args.trim();
  if (direct && (themes[direct] || direct === 'auto')) { runtime.save('theme', direct); return ui.success(`${L('Tema', 'Theme')}: ${runtime.themeName()}`); }
  const options = [{ label: L('Automático (según tu terminal)', 'Automatic (match your terminal)'), value: 'auto' }];
  for (const [id, t] of Object.entries(themes)) options.push({ label: t.name, value: id, hint: t.custom ? L('personalizado', 'custom') : '' });
  for (const o of options) if (o.value === original) { o.hint = L('actual', 'current'); o.hintColor = 'status/success'; }
  options.push({ label: L('Crear uno…', 'Create one…'), value: '__custom__' });
  const choice = await select(repl.input, {
    title: L('Elige un tema', 'Choose a theme'),
    options,
    initial: Math.max(0, options.findIndex((o) => o.value === original)),
    onChange: (opt) => setTheme(opt.value === '__custom__' ? original : opt.value, runtime.settings.customThemes),
    extra: (opt) => {
      if (opt.value === '__custom__') return [];
      const pet = resolveMascot({ ...runtime.settings, theme: opt.value }, mascots);
      return ['', ...renderMascot(pet).map((l) => `    ${l}`), '', ...samplePreview()];
    },
    erase: true,
  });
  if (!choice) { setTheme(original, runtime.settings.customThemes); return; }
  if (choice === '__custom__') { setTheme(original, runtime.settings.customThemes); return customThemeWizard(ctx); }
  runtime.save('theme', choice);
  // el cambio se ve en la bienvenida y los colores (se redibuja en su lugar); solo se anuncia sin pantalla visual
  if (ui.isScreenReader() || !liveActive()) ui.success(`${L('Tema', 'Theme')}: ${runtime.themeName()}${runtime.mascot() ? ` · ${runtime.mascot().name}` : ''}`);
}

async function mascotCommand(args, ctx) {
  const { runtime, repl } = ctx;
  const [sub, file, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  if (sub === 'import' && file) return importMascot(resolvePath(file, runtime.cwd), rest.join(' '), ctx);
  const mascots = loadMascots();
  const theme = currentTheme();
  const current = runtime.mascot();
  const options = [
    ...Object.values(mascots).map((m) => ({ label: m.name, value: m.id, hint: m.id === current?.id ? L('actual', 'current') : m.custom ? L('propia', 'yours') : '', hintColor: m.id === current?.id ? 'status/success' : 'text/dim', mascot: m })),
    { label: L('Ninguna', 'None'), value: 'none' },
    { label: L('Crear la mía desde un PNG…', 'Create mine from a PNG…'), value: '__png__' },
    { label: L('Crear la mía desde una plantilla…', 'Create mine from a template…'), value: '__template__' },
  ];
  const choice = await select(repl.input, {
    title: L(`Mascota para el tema ${theme.name}`, `Mascot for the ${theme.name} theme`),
    options,
    initial: Math.max(0, options.findIndex((o) => o.value === current?.id)),
    extra: (opt) => {
      // mascotas propias con errores: se dice cuáles y por qué (si no, simplemente "desaparecen")
      const broken = Object.entries(mascotErrors).map(([id, err]) => c.warning(`  ⚠ ${id}: ${err}`));
      if (!opt.mascot) return broken.length ? ['', ...broken] : [];
      const verbs = (opt.mascot.verbs || []).slice(0, 3).join(' · ');
      return ['', ...renderMascot(opt.mascot).map((l) => `    ${l}`), verbs ? `    ${c.soft(verbs, { italic: true })}` : '', ...broken];
    },
    erase: true,
  });
  if (!choice) return;
  if (choice === '__png__') {
    const f = await repl.input.question(`${c.accent('›')} ${L('Ruta del PNG (fondo transparente, ideal ≤ 32×32)', 'PNG path (transparent background, ideally ≤ 32×32)')}: `);
    if (!f?.trim()) return;
    const name = await repl.input.question(`${c.accent('›')} ${L('Nombre de la mascota', 'Mascot name')}: `);
    return importMascot(resolvePath(f.trim().replace(/^"|"$/g, ''), runtime.cwd), name, ctx);
  }
  if (choice === '__template__') {
    const name = (await repl.input.question(`${c.accent('›')} ${L('Nombre de la mascota', 'Mascot name')}: `))?.trim() || 'Michi';
    const id = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    const out = saveCustomMascot(id, {
      name, eyes: 'k', mouth: 'm',
      palette: { g: '#7A7A85', k: '#111111', m: '#F29CB0', p: '#F29CB0' },
      pixels: ['g........g', 'gg......gg', 'gpg....gpg', 'gggggggggg', 'gkggggggkg', 'gggggggggg', 'ggggmmgggg', '.gggggggg.'],
      verbs: L(['Ronroneando…', 'Afilando garras…', 'Persiguiendo bugs…'], ['Purring…', 'Sharpening claws…', 'Chasing bugs…']),
      themes: [],
    });
    ui.success(`${L('Plantilla creada', 'Template created')}: ${out}`);
    ui.hint(L('Edita "pixels" (cada carácter es un píxel, "." es transparente) y "palette". Luego elígela en /mascot.', 'Edit "pixels" (each character is a pixel, "." is transparent) and "palette". Then pick it in /mascot.'));
    openInEditor(out);
    return;
  }
  const scope = await select(repl.input, {
    title: L('¿Dónde la uso?', 'Where should I use it?'),
    options: [
      { label: L(`Solo con el tema ${theme.name}`, `Only with the ${theme.name} theme`), value: 'theme' },
      { label: L('Con todos los temas', 'With every theme'), value: 'all' },
    ],
    erase: true,
  });
  if (!scope) return;
  if (scope === 'theme') runtime.save(`themeMascots.${theme.id}`, choice);
  else { runtime.save('mascot.name', choice); runtime.save('themeMascots', {}); }
  // la nueva mascota aparece en la bienvenida (se redibuja en su lugar); no se imprime en la conversación
  if (ui.isScreenReader() || !liveActive()) {
    const m = runtime.mascot();
    ui.success(choice === 'none' ? L('Sin mascota.', 'No mascot.') : `${L('Mascota', 'Mascot')}: ${m?.name || '—'}`);
  }
}

async function importMascot(file, name, { runtime }) {
  if (!fs.existsSync(file)) return ui.warn(`${L('No existe', 'Not found')}: ${file}`);
  try {
    const m = pngToMascot(file, { max: 24, name: name?.trim() || path.basename(file, path.extname(file)) });
    const err = validateMascot(m);
    if (err) return ui.errorBox(L('La imagen no se pudo convertir', 'The image could not be converted'), err);
    const id = m.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    const out = saveCustomMascot(id, m);
    runtime.reload();
    runtime.save('mascot.name', id);
    ui.success(L(`Mascota "${m.name}" creada (${m.pixels[0].length}×${m.pixels.length} px): ${out}`, `Mascot "${m.name}" created (${m.pixels[0].length}×${m.pixels.length} px): ${out}`));
    for (const l of renderMascot(runtime.mascots[id] || m)) ui.println(`  ${l}`);
    ui.hint(L('Para que parpadee, indica en mascot.json qué carácter son los ojos ("eyes") y la boca ("mouth").', 'To make it blink, set which character is the eyes ("eyes") and mouth ("mouth") in mascot.json.'));
  } catch (e) {
    ui.errorBox(L('No se pudo importar el PNG', 'Could not import the PNG'), e.message, L('Usa un PNG de 8 bits sin entrelazar.', 'Use an 8-bit, non-interlaced PNG.'));
  }
}

async function accessibilityCommand(args, { runtime, repl }) {
  for (;;) {
    const a = runtime.settings.accessibility || {};
    const on = (v) => (v ? L('activado', 'on') : L('desactivado', 'off'));
    const choice = await select(repl.input, {
      title: c.primary(L('Accesibilidad', 'Accessibility'), { bold: true }),
      options: [
        { label: L('Modo lector de pantalla', 'Screen reader mode'), value: 'sr', hint: on(a.screenReader) },
        { label: L('Reducir movimiento', 'Reduce motion'), value: 'rm', hint: on(a.reduceMotion) },
        { label: L('Sin colores', 'No colors'), value: 'nc', hint: on(a.noColor) },
        { label: L('Tema de alto contraste', 'High contrast theme'), value: 'hc' },
        { label: L('Tema para daltonismo', 'Color-blind theme'), value: 'cb' },
        { label: L('Comprobar el contraste del tema actual', 'Check current theme contrast'), value: 'check' },
      ],
      footer: L('↑↓ mover · enter cambiar · esc salir', '↑↓ move · enter toggle · esc exit'),
      erase: true,
    });
    if (!choice) return;
    if (choice === 'sr') runtime.save('accessibility.screenReader', !a.screenReader);
    else if (choice === 'rm') runtime.save('accessibility.reduceMotion', !a.reduceMotion);
    else if (choice === 'nc') runtime.save('accessibility.noColor', !a.noColor);
    else if (choice === 'hc') runtime.save('theme', 'alto-contraste');
    else if (choice === 'cb') runtime.save('theme', 'daltonico');
    else if (choice === 'check') {
      const w = validateContrast(currentTheme().tokens);
      if (!w.length) ui.success(L(`${runtime.themeName()} cumple WCAG AA en todo el texto.`, `${runtime.themeName()} meets WCAG AA for all text.`));
      else { ui.warn(L(`${runtime.themeName()} tiene ${w.length} combinaciones con poco contraste:`, `${runtime.themeName()} has ${w.length} low-contrast combinations:`)); for (const x of w.slice(0, 8)) ui.println(`  ${c.warning('·')} ${x}`); }
      return;
    }
  }
}

// Panel interactivo de configuración.
async function configPanel(ctx) {
  const { runtime, repl } = ctx;
  let scope = 'user';
  for (;;) {
    const s = runtime.settings;
    const yes = (v) => (v ? L('sí', 'yes') : 'no');
    const items = [
      { key: 'scope', label: L('Ámbito', 'Scope'), value: scope === 'user' ? L('usuario', 'user') : L('proyecto', 'project') },
      { key: 'language', label: L('Idioma', 'Language'), value: s.language === 'en' ? 'English' : 'Español' },
      { key: 'theme', label: L('Tema', 'Theme'), value: runtime.themeName() },
      { key: 'mascot', label: L('Mascota', 'Mascot'), value: runtime.mascot()?.name || L('ninguna', 'none') },
      { key: 'outputStyle', label: L('Estilo de respuesta', 'Response style'), value: s.outputStyle },
      { key: 'thinking', label: L('Pensamiento del modelo', 'Model thinking'), value: s.thinking === false ? L('apagado (más rápido)', 'off (faster)') : L('encendido', 'on') },
      { key: 'showThinking', label: L('Mostrar pensamiento completo', 'Show full thinking'), value: yes(s.showThinking) },
      { key: 'permissions.mode', label: L('Modo de permisos inicial', 'Default permission mode'), value: s.permissions?.mode || 'default' },
      { key: 'spinnerVerbs', label: L('Verbos del spinner', 'Spinner verbs'), value: s.spinnerVerbs?.length ? s.spinnerVerbs.join(', ') : L('los de la mascota', "the mascot's") },
      { key: 'autoCompact', label: L('Autocompactar contexto', 'Auto-compact context'), value: s.autoCompact ? `${Math.round(s.autoCompact * 100)} %` : 'no' },
      { key: 'contextWindow', label: L('Ventana de contexto', 'Context window'), value: `${s.contextWindow}` },
      { key: 'lean', label: L('Modo ligero (menos tokens)', 'Lean mode (fewer tokens)'), value: s.lean === true || s.lean === false ? yes(s.lean) : L(`auto (${runtime.isLean() ? 'activo' : 'inactivo'})`, `auto (${runtime.isLean() ? 'on' : 'off'})`) },
      { key: 'notifications', label: L('Sonido al terminar', 'Sound when done'), value: yes(s.notifications) },
      { key: 'offline', label: L('Modo offline', 'Offline mode'), value: yes(s.offline) },
      { key: 'accessibility', label: L('Accesibilidad…', 'Accessibility…'), value: '' },
    ];
    const key = await select(repl.input, {
      title: c.primary(L('Configuración', 'Settings'), { bold: true }),
      options: items.map((it) => ({ label: it.label.padEnd(30), value: it.key, hint: it.value, hintColor: 'accent/soft' })),
      footer: L('↑↓ mover · enter cambiar · esc salir', '↑↓ move · enter change · esc exit'),
      erase: true,
    });
    if (!key) return;
    const toggle = (k, cur) => runtime.save(k, !cur, scope);
    switch (key) {
      case 'scope': scope = scope === 'user' ? 'project' : 'user'; break;
      case 'language': { const l = s.language === 'en' ? 'es' : 'en'; runtime.save('language', l, scope); setLanguage(l); break; }
      case 'theme': await themeCommand('', ctx); break;
      case 'mascot': await mascotCommand('', ctx); break;
      case 'accessibility': await accessibilityCommand('', ctx); break;
      case 'lean': runtime.save('lean', s.lean === true ? false : s.lean === false ? 'auto' : true, scope); break; // sí → no → auto
      case 'showThinking': case 'notifications': case 'offline': toggle(key, s[key]); break;
      case 'thinking': runtime.save('thinking', s.thinking === false ? true : false, scope); break;
      case 'spinnerVerbs': {
        const v = await repl.input.question(`${c.accent('›')} ${L('Verbos separados por coma (vacío = los de la mascota)', 'Comma-separated verbs (empty = mascot verbs)')}: `);
        runtime.save(key, v?.trim() ? v.split(',').map((x) => x.trim()).filter(Boolean).map((x) => (x.endsWith('…') ? x : `${x}…`)) : [], scope);
        break;
      }
      case 'outputStyle': {
        const v = await select(repl.input, { title: L('Estilo de respuesta', 'Response style'), options: [
          { label: 'normal', value: 'normal' },
          { label: L('conciso', 'concise'), value: 'conciso' },
          { label: L('explicativo', 'explanatory'), value: 'explicativo' },
          { label: L('aprendizaje', 'learning'), value: 'aprendizaje' },
        ] });
        if (v) runtime.save(key, v, scope);
        break;
      }
      case 'permissions.mode': {
        const v = await select(repl.input, { title: L('Modo de permisos inicial', 'Default permission mode'), options: MODES.map((m) => ({ label: MODE_INFO[m].label, value: m, hint: MODE_INFO[m].hint })) });
        if (v) runtime.save(key, v, scope);
        break;
      }
      case 'autoCompact': {
        const v = await select(repl.input, { title: L('Autocompactar al llegar a…', 'Auto-compact at…'), options: [{ label: '70 %', value: 0.7 }, { label: '85 %', value: 0.85 }, { label: '95 %', value: 0.95 }, { label: L('Nunca', 'Never'), value: 0 }] });
        if (v !== null && v !== undefined) runtime.save(key, v, scope);
        break;
      }
      case 'contextWindow': {
        const v = Number(await repl.input.question(`${c.accent('›')} ${L('Tokens de contexto (8192, 16384, 32768…)', 'Context tokens (8192, 16384, 32768…)')}: `));
        if (v >= 2048) runtime.save(key, v, scope);
        break;
      }
      default: break;
    }
  }
}

export function customizeCommands({ legacyConfig }) {
  return {
    theme: { get description() { return L('Elige el tema de colores (con vista previa) o crea uno', 'Pick a color theme (with preview) or create one'); }, argumentHint: '[theme]', run: themeCommand },
    mascot: { get description() { return L('Elige la mascota de cada tema o crea la tuya', 'Pick the mascot for each theme or create yours'); }, aliases: ['mascota'], argumentHint: '[import <png> <name>]', run: mascotCommand },
    accessibility: { get description() { return L('Lector de pantalla, reducir movimiento, sin color, temas accesibles', 'Screen reader, reduced motion, no color, accessible themes'); }, aliases: ['accesibilidad', 'a11y'], run: accessibilityCommand },
    config: {
      get description() { return L('Panel de configuración (o get/set <clave> <valor>)', 'Settings panel (or get/set <key> <value>)'); },
      argumentHint: '[get <key> | set <key> <value>]',
      async run(args, ctx) {
        if (args.trim() || !ctx.repl.input?.tty) return legacyConfig(args, ctx);
        return configPanel(ctx);
      },
    },
  };
}
