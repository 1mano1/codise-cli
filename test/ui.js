// Pruebas de la consola interactiva (caja v2) usando una terminal virtual.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runHarness(file) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'test', file)], { env: { ...process.env, NO_COLOR: '' } });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => p.kill(), 60000);
    p.on('close', () => {
      clearTimeout(t);
      try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { resolve({ error: err || out }); }
    });
  });
}

const lastLines = (screen, n) => screen.split('\n').slice(-n);

export async function uiTests(t) {
  const shots = await runHarness('ui-harness.js');

  await t('consola v2: bienvenida compacta, caja al pie y estado debajo', async (assert) => {
    assert(!shots.error, shots.error);
    const s = shots.inicio;
    assert(s.includes('✻ Códice') && s.includes('mock-coder:7b'), 'contenedor de bienvenida con versión y modelo');
    assert(!s.includes('██████'), 'sin banner gigante');
    const [top, body, bottom, status] = lastLines(s, 4);
    assert(top.startsWith('╭') && bottom.startsWith('╰') && body.startsWith('│ ›'), 'caja de escritura al pie');
    assert(status.includes('shift+tab') && status.includes('mock-coder:7b'), 'estado debajo de la caja');
    assert(!body.includes('shift+tab'), 'el estado no va pegado al texto');
  });

  await t('consola v2: paleta "/" debajo de la caja', async (assert) => {
    const lines = shots.paleta.split('\n');
    const boxEnd = lines.findLastIndex((l) => l.startsWith('╰'));
    assert(lines[boxEnd - 1].includes('/mo'), 'lo escrito queda en la caja');
    assert(lines.slice(boxEnd + 1).some((l) => l.includes('/models')), 'la paleta aparece debajo');
  });

  await t('consola v2: texto largo crece en la caja y el mensaje queda en la conversación', async (assert) => {
    const box = shots.textoLargo.split('\n').filter((l) => l.startsWith('│'));
    assert(box.length >= 2, 'la caja creció a varias líneas');
    assert(shots.respuesta.includes('› hola') && shots.respuesta.includes('¿En qué te ayudo?'), 'eco del mensaje y respuesta arriba');
  });

  await t('consola v2: diálogo de permisos encima de la caja, sin desbordes', async (assert) => {
    const lines = shots.permiso.split('\n');
    const dlg = lines.findIndex((l) => l.includes('Permiso requerido'));
    const box = lines.findLastIndex((l) => l.startsWith('│ ›'));
    assert(dlg > 0 && box > dlg, 'diálogo encima de la caja');
    assert(lines.some((l) => l.includes('module.exports')), 'comando largo completo en varias líneas');
    assert(lines.every((l) => [...l].length <= 90), 'ninguna línea excede el ancho');
    assert(shots.final.includes('Listo: creé memory.js.') && !shots.final.includes('Permiso requerido'), 'el diálogo desaparece al responder');
  });

  await t('consola v2: la caja va pegada al fondo desde el inicio', async (assert) => {
    assert(shots.inicio.split('\n').length >= 34, 'la zona viva se empuja al último renglón de la terminal');
  });

  await t('consola v2: el texto aparece mientras llega (no de golpe)', async (assert) => {
    assert(shots.streaming.includes('Este es un') && !shots.streaming.includes('fluida.'), 'se ve el texto a medias mientras llega');
    assert(shots.streamFin.includes('se ve fluida.'), 'el texto termina completo');
    assert(shots.streamFin.split('\n').filter((l) => l.includes('Este es un texto')).length === 1, 'sin duplicados al terminar');
  });

  await t('consola v2: responsiva al cambiar el ancho de la terminal', async (assert) => {
    const lines = shots.angosta.split('\n');
    assert(lines.every((l) => [...l].length <= 60), 'nada excede el nuevo ancho');
    assert(shots.angosta.includes('› hola') && shots.angosta.includes('› otro'), 'se conservan los mensajes del usuario');
    assert(!shots.angosta.includes('▀▀▀'), 'la mascota se oculta en ventanas angostas');
    assert(lines.filter((l) => l.trim()).at(-1).includes('shift+tab'), 'la caja y el estado siguen al fondo');
  });

  const onb = await runHarness('ui-onboarding.js');
  await t('consola v2: asistente de inicio sin caja ni barra y con nombres traducidos', async (assert) => {
    assert(!onb.error, onb.error);
    assert(onb.temaMovido.includes('Dawn (light)') && !onb.temaMovido.includes('Alba (claro)'), 'temas en inglés');
    assert(!onb.temaMovido.includes('shift+tab'), 'sin barra de estado durante el asistente');
    assert(!onb.temaMovido.includes('██████'), 'vista previa sin banner gigante');
    assert(lastLines(onb.final, 4)[0].startsWith('╭'), 'la caja vuelve al terminar');
  });
}
