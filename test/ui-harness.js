// Ejecuta la consola interactiva (caja de escritura v2) en una terminal virtual y devuelve capturas de pantalla.
// Uso: node test/ui-harness.js  (imprime las capturas en JSON por la salida original)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VirtualTerminal } from './fixtures/vt.js';
import { startMockLLM } from './fixtures/mock-llm.js';

const realWrite = process.stdout.write.bind(process.stdout);
const vt = new VirtualTerminal(90, 34);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codice-ui-'));
const proj = path.join(home, 'proyecto');
fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ onboarded: true, language: 'es', theme: 'brasa' }));
process.env.CODICE_HOME = home;
process.env.FORCE_COLOR = '3';
process.chdir(proj);

// terminal falsa
Object.assign(process.stdout, { isTTY: true, columns: 90, rows: 34 });
process.stdout.write = (d) => { vt.write(d); return true; };
process.stdout.on = () => process.stdout;
process.stdout.off = () => process.stdout;
process.stdin.isTTY = true;
process.stdin.setRawMode = () => {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (s, k = {}) => process.stdin.emit('keypress', s, { name: s, sequence: s, ...k });
const type = async (text) => { for (const ch of text) { key(ch, { name: ch.toLowerCase() }); await sleep(2); } };
const enter = () => key('\r', { name: 'return' });
const waitFor = async (pred, ms = 8000) => { const t0 = Date.now(); while (!pred() && Date.now() - t0 < ms) await sleep(25); return pred(); };

const shots = {};
const m = await startMockLLM({ script: [
  { content: 'Hola, soy Códice. ¿En qué te ayudo?' },
  { toolCalls: [{ name: 'Bash', args: { command: "echo 'const memory = []; const add = (key, value) => { memory[key] = value; }; module.exports = { add };' > memory.js", description: 'Crea memory.js' } }] },
  { content: 'Listo: creé memory.js.' },
] });

const { Runtime } = await import('../src/runtime.js');
const { Session } = await import('../src/session.js');
const { startRepl } = await import('../src/repl.js');
const runtime = new Runtime({ cwd: proj, overrides: { baseUrl: `${m.url}/v1`, model: 'mock-coder:7b' } });
startRepl(runtime, { session: new Session({ cwd: proj }) });

await waitFor(() => vt.screen().includes('╰'));
await sleep(100);
shots.inicio = vt.screen();

await type('/mo');
await sleep(80);
shots.paleta = vt.screen();
key('', { name: 'escape' });
for (let i = 0; i < 3; i++) key('', { name: 'backspace' });

await type('hola');
await sleep(50);
shots.escribiendo = vt.screen();
enter();
await waitFor(() => vt.screen().includes('¿En qué te ayudo?'));
await sleep(150);
shots.respuesta = vt.screen();

await type('crea un script basico en js con memoria persistente para guardar claves y valores usando un objeto');
await sleep(50);
shots.textoLargo = vt.screen();
enter();
await waitFor(() => vt.screen().includes('Permiso requerido'));
await sleep(100);
shots.permiso = vt.screen();
key('1', { name: '1' });
await waitFor(() => vt.screen().includes('Listo: creé memory.js.'));
await sleep(150);
shots.final = vt.screen();
shots.cursor = vt.cursor();

realWrite(`${JSON.stringify(shots)}\n`);
await m.close();
process.exit(0);
