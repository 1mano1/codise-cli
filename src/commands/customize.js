// Personalización: /theme, /mascot y el panel /config.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HOME } from '../config.js';
import { c, style, allThemes, setTheme, currentTheme, validateContrast, TOKENS } from '../ui/theme.js';
import { renderMascot, saveCustomMascot, validateMascot, loadMascots } from '../ui/mascot.js';
import * as ui from '../ui/output.js';
import { select } from '../ui/select.js';
import { pngToMascot } from '../util/png.js';
import { resolvePath } from '../util/fs.js';
import { MODES, MODE_INFO } from '../permissions.js';

function themePreview() {
  return [
    '',
    c.muted('Vista previa', { bold: true }),
    `  ${c.accent('›', { bold: true })} ${c.primary('arregla el bug del login')}`,
    `  ${c.soft('✻ Olfateando…', { italic: true })} ${c.dim('busco la función de validación')}`,
    `  ${c.success('●', { bold: true })} ${style('Edit', { bold: true, fg: 'text/primary' })}${c.muted('(src/auth.ts)')}`,
    `    ${c.dim('└ 1 cambio · +1 −1')}`,
    `  ${style('  12 ', { fg: 'text/dim', bg: 'diff/del-bg' })}${style('- ', { fg: 'status/error', bg: 'diff/del-bg', bold: true })}${style('if (user = null) return;      ', { fg: 'text/primary', bg: 'diff/del-bg' })}`,
    `  ${style('  12 ', { fg: 'text/dim', bg: 'diff/add-bg' })}${style('+ ', { fg: 'status/success', bg: 'diff/add-bg', bold: true })}${style('if (user === null) return;    ', { fg: 'text/primary', bg: 'diff/add-bg' })}`,
    `  ${c.warning('⚠ aviso')}  ${c.error('✗ error')}  ${c.agent('↳ subagente')}  ${c.info('◆ mcp')}  ${c.success('✓ listo')}`,
  ];
}

function openInEditor(file) {
  const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'nano');
  spawn(editor, [file], { stdio: 'inherit', shell: process.platform === 'win32', detached: process.platform === 'win32' });
}

async function customThemeWizard({ runtime, repl }) {
  const themes = allThemes(runtime.settings.customThemes);
  const base = await select(repl.input, { title: 'Tema base', options: Object.entries(themes).filter(([, t]) => !t.custom).map(([id, t]) => ({ label: t.name, value: id })) });
  if (!base) return;
  const name = (await repl.input.question(`${c.accent('›')} Nombre del tema: `))?.trim() || 'mi-tema';
  const id = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const tokens = {};
  ui.hint(`Escribe colores en formato #RRGGBB (enter para dejar el del tema base). Tokens: ${TOKENS.join(', ')}`);
  for (const tk of ['accent/primary', 'accent/soft', 'bg/surface']) {
    const v = (await repl.input.question(`${c.accent('›')} ${tk} ${c.dim(`(${themes[base].tokens[tk]})`)}: `))?.trim();
    if (/^#[0-9a-f]{6}$/i.test(v || '')) tokens[tk] = v.toUpperCase();
  }
  const full = { ...themes[base].tokens, ...tokens };
  const warnings = validateContrast(full);
  runtime.save(`customThemes.${id}`, { name, base, tokens });
  runtime.save('theme', id);
  ui.success(`Tema "${name}" creado y activado. Puedes ajustar más tokens en ${path.join(HOME, 'settings.json')} (customThemes.${id}.tokens).`);
  if (warnings.length) {
    ui.warn('Algunos colores no alcanzan el contraste mínimo WCAG (4.5:1):');
    for (const w of warnings.slice(0, 6)) ui.println(`  ${c.warning('·')} ${w}`);
  } else ui.success('Contraste verificado: todo el texto cumple WCAG AA.');
}

async function themeCommand(args, ctx) {
  const { runtime, repl } = ctx;
  const themes = allThemes(runtime.settings.customThemes);
  const original = runtime.settings.theme || 'auto';
  const direct = args.trim();
  if (direct && (themes[direct] || direct === 'auto')) { runtime.save('theme', direct); return ui.success(`Tema: ${direct === 'auto' ? `automático (${runtime.themeName()})` : themes[direct].name}`); }
  const options = [{ label: 'Automático (según la terminal)', value: 'auto', hint: original === 'auto' ? 'actual' : 'claro u oscuro', hintColor: original === 'auto' ? 'status/success' : 'text/dim' }];
  options.push(...Object.entries(themes).map(([id, t]) => ({
    label: t.name,
    value: id,
    hint: [id === original ? 'actual' : '', id === 'daltonico' ? 'verde/rojo → azul/naranja' : '', id === 'alto-contraste' ? '≥ 7:1' : '', t.custom ? 'personalizado' : ''].filter(Boolean).join(' · '),
    hintColor: id === original ? 'status/success' : 'text/dim',
  })));
  options.push({ label: 'Personalizado…', value: '__custom__', hint: 'crear un tema a partir de otro' });
  const choice = await select(repl.input, {
    title: `Elige un tema ${c.dim('(la vista previa cambia al moverte)')}`,
    options,
    initial: Math.max(0, options.findIndex((o) => o.value === original)),
    onChange: (opt) => setTheme(opt.value === '__custom__' ? original : opt.value, runtime.settings.customThemes),
    extra: () => themePreview(),
  });
  if (!choice) { setTheme(original, runtime.settings.customThemes); return; }
  if (choice === '__custom__') { setTheme(original, runtime.settings.customThemes); return customThemeWizard(ctx); }
  runtime.save('theme', choice);
  ui.success(`Tema: ${runtime.themeName()}${choice === 'auto' ? ' (automático)' : ''}${runtime.settings.mascot?.name === 'auto' ? ` · mascota: ${runtime.mascot()?.name || 'ninguna'}` : ''}`);
}

// Accesos rápidos de accesibilidad.
async function accessibilityCommand(args, { runtime, repl }) {
  for (;;) {
    const a = runtime.settings.accessibility || {};
    const yes = (v) => (v ? 'activado' : 'desactivado');
    const choice = await select(repl.input, {
      title: c.primary('Accesibilidad', { bold: true }),
      options: [
        { label: 'Modo lector de pantalla', value: 'sr', hint: `${yes(a.screenReader)} · frases completas, sin dibujos ni animaciones` },
        { label: 'Reducir movimiento', value: 'rm', hint: `${yes(a.reduceMotion)} · spinner y mascota estáticos` },
        { label: 'Sin colores', value: 'nc', hint: `${yes(a.noColor)} · solo símbolos y texto` },
        { label: 'Tema de alto contraste', value: 'hc', hint: 'texto ≥ 7:1' },
        { label: 'Tema para daltonismo', value: 'cb', hint: 'verde/rojo → azul/naranja' },
        { label: 'Tema automático', value: 'auto', hint: 'claro u oscuro según la terminal' },
        { label: 'Comprobar el contraste del tema actual', value: 'check' },
      ],
      footer: '↑↓ mover · enter cambiar · esc salir',
      collapse: false,
      erase: true,
    });
    if (!choice) return;
    if (choice === 'sr') runtime.save('accessibility.screenReader', !a.screenReader);
    else if (choice === 'rm') runtime.save('accessibility.reduceMotion', !a.reduceMotion);
    else if (choice === 'nc') runtime.save('accessibility.noColor', !a.noColor);
    else if (choice === 'hc') runtime.save('theme', 'alto-contraste');
    else if (choice === 'cb') runtime.save('theme', 'daltonico');
    else if (choice === 'auto') runtime.save('theme', 'auto');
    else if (choice === 'check') {
      const w = validateContrast(currentTheme().tokens);
      if (!w.length) ui.success(`El tema ${runtime.themeName()} cumple WCAG AA en todo el texto (≥ 4.5:1).`);
      else { ui.warn(`El tema ${runtime.themeName()} tiene ${w.length} combinaciones con poco contraste:`); for (const x of w.slice(0, 8)) ui.println(`  ${c.warning('·')} ${x}`); }
      return;
    }
    ui.success(`Accesibilidad actualizada. Tema: ${runtime.themeName()}.`);
  }
}

async function mascotCommand(args, ctx) {
  const { runtime, repl } = ctx;
  const [sub, file, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  if (sub === 'import' && file) return importMascot(resolvePath(file, runtime.cwd), rest.join(' '), ctx);
  const mascots = loadMascots();
  const current = runtime.settings.mascot?.name || 'auto';
  const themeMascot = mascots[currentTheme().mascot];
  const options = [
    { label: 'Automática (según el tema)', value: 'auto', hint: `ahora: ${themeMascot?.name || '—'}`, mascot: themeMascot },
    ...Object.values(mascots).map((m) => ({ label: m.name, value: m.id, hint: m.custom ? 'propia' : `tema ${Object.entries(allThemes()).filter(([, t]) => t.mascot === m.id).map(([, t]) => t.name.split(' ')[0]).join(', ') || '—'}`, mascot: m })),
    { label: 'Ninguna', value: 'none' },
    { label: 'Crear la mía desde un PNG…', value: '__png__' },
    { label: 'Crear la mía desde una plantilla…', value: '__template__' },
  ];
  const choice = await select(repl.input, {
    title: 'Mascota',
    options,
    initial: Math.max(0, options.findIndex((o) => o.value === current)),
    extra: (opt) => {
      if (!opt.mascot) return [];
      const art = renderMascot(opt.mascot, 'idle');
      const verbs = (opt.mascot.verbs || []).slice(0, 3).join(' · ');
      return ['', ...art.map((l) => `    ${l}`), verbs ? `    ${c.soft(verbs, { italic: true })}` : ''];
    },
  });
  if (!choice) return;
  if (choice === '__png__') {
    const f = await repl.input.question(`${c.accent('›')} Ruta del PNG (fondo transparente, idealmente ≤ 32×32): `);
    if (!f?.trim()) return;
    const name = await repl.input.question(`${c.accent('›')} Nombre de la mascota: `);
    return importMascot(resolvePath(f.trim().replace(/^"|"$/g, ''), runtime.cwd), name, ctx);
  }
  if (choice === '__template__') {
    const name = (await repl.input.question(`${c.accent('›')} Nombre de la mascota: `))?.trim() || 'Michi';
    const id = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    const fileOut = saveCustomMascot(id, {
      name,
      eyes: 'k',
      mouth: 'm',
      palette: { g: '#7A7A85', k: '#111111', m: '#F29CB0', p: '#F29CB0' },
      pixels: ['g........g', 'gg......gg', 'gpg....gpg', 'gggggggggg', 'gkggggggkg', 'gggggggggg', 'ggggmmgggg', '.gggggggg.'],
      verbs: ['Ronroneando…', 'Afilando garras…', 'Persiguiendo bugs…'],
      themes: [],
    });
    ui.success(`Plantilla creada: ${fileOut}`);
    ui.hint('Edita "pixels" (cada carácter es un píxel, "." es transparente) y "palette". Cuando guardes, elígela en /mascot.');
    openInEditor(fileOut);
    return;
  }
  runtime.save('mascot.name', choice);
  const m = runtime.mascot();
  ui.success(choice === 'none' ? 'Mascota desactivada.' : `Mascota: ${m?.name || '—'}`);
  for (const l of renderMascot(m, 'idle')) ui.println(`  ${l}`);
}

async function importMascot(file, name, { runtime }) {
  if (!fs.existsSync(file)) return ui.warn(`No existe: ${file}`);
  try {
    const m = pngToMascot(file, { max: 24, name: name?.trim() || path.basename(file, path.extname(file)) });
    const err = validateMascot(m);
    if (err) return ui.errorBox('La imagen no se pudo convertir', err);
    const id = m.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    const out = saveCustomMascot(id, m);
    runtime.reload();
    runtime.save('mascot.name', id);
    ui.success(`Mascota "${m.name}" creada (${m.pixels[0].length}×${m.pixels.length} px, ${Object.keys(m.palette).length} colores): ${out}`);
    for (const l of renderMascot(runtime.mascots[id] || m, 'idle')) ui.println(`  ${l}`);
    ui.hint('Para que parpadee y cambie de expresión, indica en mascot.json qué carácter son los ojos ("eyes") y la boca ("mouth").');
  } catch (e) {
    ui.errorBox('No se pudo importar el PNG', e.message, 'Usa un PNG de 8 bits sin entrelazar');
  }
}

// Panel interactivo de configuración.
async function configPanel(ctx) {
  const { runtime, repl } = ctx;
  let scope = 'user';
  for (;;) {
    const s = runtime.settings;
    const yes = (v) => (v ? 'sí' : 'no');
    const items = [
      { key: 'scope', label: 'Ámbito', value: scope === 'user' ? 'usuario (todos los proyectos)' : 'proyecto (.codice/settings.json)' },
      { key: 'theme', label: 'Tema', value: runtime.themeName() },
      { key: 'mascot', label: 'Mascota', value: s.mascot?.name === 'auto' ? `automática (${runtime.mascot()?.name || '—'})` : s.mascot?.name },
      { key: 'mascot.animated', label: 'Animar mascota', value: yes(s.mascot?.animated !== false) },
      { key: 'spinnerVerbs', label: 'Verbos del spinner', value: s.spinnerVerbs?.length ? s.spinnerVerbs.join(', ') : 'los de la mascota' },
      { key: 'outputStyle', label: 'Estilo de respuesta', value: s.outputStyle },
      { key: 'showThinking', label: 'Mostrar pensamiento', value: yes(s.showThinking) },
      { key: 'permissions.mode', label: 'Modo de permisos inicial', value: s.permissions?.mode || 'default' },
      { key: 'autoCompact', label: 'Autocompactar contexto', value: s.autoCompact ? `al ${Math.round(s.autoCompact * 100)} %` : 'no' },
      { key: 'contextWindow', label: 'Ventana de contexto', value: `${s.contextWindow} tokens` },
      { key: 'lean', label: 'Modo ligero (modelos pequeños)', value: yes(s.lean) },
      { key: 'notifications', label: 'Avisar al terminar (sonido)', value: yes(s.notifications) },
      { key: 'offline', label: 'Modo offline', value: yes(s.offline) },
      { key: 'accessibility.screenReader', label: 'Lector de pantalla', value: yes(s.accessibility?.screenReader) },
      { key: 'accessibility.reduceMotion', label: 'Reducir movimiento', value: yes(s.accessibility?.reduceMotion) },
    ];
    const key = await select(repl.input, {
      title: c.primary('Configuración', { bold: true }),
      options: items.map((it) => ({ label: it.label.padEnd(30), value: it.key, hint: it.value, hintColor: 'accent/soft' })),
      footer: '↑↓ mover · enter cambiar · esc salir',
      collapse: false,
      erase: true,
    });
    if (!key) return;
    const toggle = (k, cur) => runtime.save(k, !cur, scope);
    switch (key) {
      case 'scope': scope = scope === 'user' ? 'project' : 'user'; break;
      case 'theme': await themeCommand('', ctx); break;
      case 'mascot': await mascotCommand('', ctx); break;
      case 'mascot.animated': toggle(key, s.mascot?.animated !== false); break;
      case 'showThinking': case 'lean': case 'notifications': case 'offline': toggle(key, s[key]); break;
      case 'accessibility.screenReader': toggle(key, s.accessibility?.screenReader); break;
      case 'accessibility.reduceMotion': toggle(key, s.accessibility?.reduceMotion); break;
      case 'spinnerVerbs': {
        const v = await repl.input.question(`${c.accent('›')} Verbos separados por coma (vacío = los de la mascota): `);
        runtime.save(key, v?.trim() ? v.split(',').map((x) => x.trim()).filter(Boolean).map((x) => (x.endsWith('…') ? x : `${x}…`)) : [], scope);
        break;
      }
      case 'outputStyle': {
        const v = await select(repl.input, { title: 'Estilo de respuesta', options: [
          { label: 'normal', value: 'normal', hint: 'equilibrado' },
          { label: 'conciso', value: 'conciso', hint: 'lo mínimo' },
          { label: 'explicativo', value: 'explicativo', hint: 'explica decisiones' },
          { label: 'aprendizaje', value: 'aprendizaje', hint: 'te enseña y te deja escribir partes' },
        ] });
        if (v) runtime.save(key, v, scope);
        break;
      }
      case 'permissions.mode': {
        const v = await select(repl.input, { title: 'Modo de permisos inicial', options: MODES.map((m) => ({ label: MODE_INFO[m].label, value: m, hint: MODE_INFO[m].hint })) });
        if (v) runtime.save(key, v, scope);
        break;
      }
      case 'autoCompact': {
        const v = await select(repl.input, { title: 'Autocompactar al llegar a…', options: [{ label: '70 %', value: 0.7 }, { label: '85 %', value: 0.85 }, { label: '95 %', value: 0.95 }, { label: 'Nunca', value: 0 }] });
        if (v !== null && v !== undefined) runtime.save(key, v, scope);
        break;
      }
      case 'contextWindow': {
        const v = Number(await repl.input.question(`${c.accent('›')} Tokens de contexto (p. ej. 8192, 16384, 32768): `));
        if (v >= 2048) runtime.save(key, v, scope);
        break;
      }
      default: break;
    }
  }
}

export function customizeCommands({ legacyConfig }) {
  return {
    theme: { description: 'Elige el tema de colores (con vista previa) o crea uno', argumentHint: '[tema]', run: themeCommand },
    mascot: { description: 'Elige tu mascota o crea la tuya (plantilla o PNG)', aliases: ['mascota'], argumentHint: '[import <png> <nombre>]', run: mascotCommand },
    accessibility: { description: 'Lector de pantalla, reducir movimiento, sin color, temas accesibles', aliases: ['accesibilidad', 'a11y'], run: accessibilityCommand },
    config: {
      description: 'Panel de configuración (o get/set <clave> <valor>)',
      argumentHint: '[get <clave> | set <clave> <valor>]',
      async run(args, ctx) {
        if (args.trim() || !ctx.repl.input?.tty) return legacyConfig(args, ctx);
        return configPanel(ctx);
      },
    },
  };
}
