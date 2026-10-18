// Pruebas de punta a punta del modo no interactivo contra el servidor LLM falso.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockLLM } from './fixtures/mock-llm.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'codice.js');

export function runCli(args, { cwd, home, input = '', timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, CODICE_HOME: home, NO_COLOR: '1' } });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => p.kill(), timeout);
    p.on('close', (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
    p.stdin.end(input);
  });
}

export async function e2eTests(t) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codice-e2e-'));
  const home = path.join(work, '.home');
  const cwd = path.join(work, 'proyecto');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(cwd, '.git'));
  const m = await startMockLLM();
  const base = ['--base-url', `${m.url}/v1`, '--model', 'mock-coder:7b'];
  const opts = { cwd, home };

  try {
    await t('herramientas nativas: Write + Read con --yolo', async (assert) => {
      m.push(
        { content: 'Creo el archivo.', toolCalls: [{ name: 'Write', args: { file_path: 'hola.txt', content: 'hola mundo\n' } }] },
        { toolCalls: [{ name: 'Read', args: { file_path: 'hola.txt' } }] },
        { content: 'Listo: hola.txt creado.' },
      );
      const r = await runCli(['-p', 'crea hola.txt', '--yolo', ...base], opts);
      assert(r.status === 0, `código ${r.status}: ${r.stderr}`);
      assert(fs.readFileSync(path.join(cwd, 'hola.txt'), 'utf8') === 'hola mundo\n', 'archivo creado');
      assert(r.stdout.includes('Listo: hola.txt creado.'), 'respuesta final en stdout');
      assert(r.stderr.includes('Write(hola.txt)'), 'registro de herramientas en stderr');
    });

    await t('sin permiso en modo -p: la herramienta se deniega', async (assert) => {
      m.push({ toolCalls: [{ name: 'Bash', args: { command: 'echo x' } }] }, { content: 'No tengo permiso.' });
      const r = await runCli(['-p', 'ejecuta echo', ...base], opts);
      const last = m.requests.at(-1).body.messages.at(-1);
      assert(r.status === 0, `código ${r.status}`);
      assert(last.role === 'tool' && last.content.startsWith('Permiso denegado'), `resultado: ${last.content}`);
    });

    await t('modelo sin tools nativas: cambia a modo prompt', async (assert) => {
      m.push(
        { error: { status: 400, body: '{"error":"registry.ollama.ai/library/tiny does not support tools"}' } },
        { content: 'Voy a listar.\n<tool_call>\n{"name": "LS", "arguments": {}}\n</tool_call>' },
        { content: 'Hay un archivo hola.txt.' },
      );
      const r = await runCli(['-p', 'lista archivos', '--yolo', '--base-url', `${m.url}/v1`, '--model', 'tiny:1b'], opts);
      const req = m.requests.at(-1).body;
      assert(r.status === 0, `código ${r.status}: ${r.stderr}`);
      assert(!req.tools, 'sin tools nativas en la petición');
      assert(req.messages[0].content.includes('<tool_call>'), 'herramientas descritas en el system prompt');
      assert(req.messages.at(-1).content.includes('<tool_result name="LS">'), 'resultado devuelto como <tool_result>');
      assert(r.stdout.includes('Hay un archivo hola.txt.'), 'respuesta final');
    });

    await t('subagentes en paralelo y salida JSON', async (assert) => {
      m.push(
        { toolCalls: [{ name: 'Task', args: { description: 'buscar a', prompt: 'busca A', subagent_type: 'explore' } }, { name: 'Task', args: { description: 'buscar b', prompt: 'busca B', subagent_type: 'explore' } }] },
        { content: 'Resultado A' },
        { content: 'Resultado B' },
        { content: 'Ambos subagentes terminaron.' },
      );
      const r = await runCli(['-p', 'investiga', '--yolo', '--output-format', 'json', ...base], opts);
      const j = JSON.parse(r.stdout);
      assert(j.result === 'Ambos subagentes terminaron.', `resultado: ${j.result}`);
      const subTools = m.requests.at(-3).body.tools.map((x) => x.function.name).sort().join(',');
      assert(subTools === 'Glob,Grep,LS,Read', `herramientas de explore: ${subTools}`);
      const toolMsgs = m.requests.at(-1).body.messages.filter((x) => x.role === 'tool').map((x) => x.content).sort();
      assert(toolMsgs.join('|') === 'Resultado A|Resultado B', `resultados: ${toolMsgs}`);
    });

    await t('entrada por tubería y --continue', async (assert) => {
      m.push({ content: 'Resumen: ok.' });
      let r = await runCli(['-p', 'resume', ...base], { ...opts, input: 'texto por stdin' });
      assert(r.status === 0 && m.requests.at(-1).body.messages.at(-1).content.includes('<stdin>'), 'stdin adjuntado');
      m.push({ content: 'Sigo aquí.' });
      r = await runCli(['-p', 'continúa', '--continue', ...base], opts);
      const msgs = m.requests.at(-1).body.messages;
      assert(msgs.some((x) => x.role === 'assistant' && x.content === 'Resumen: ok.'), 'historial previo cargado');
    });

    await t('consola interactiva por tubería: comandos, shell, memoria y prompt', async (assert) => {
      m.push({ content: 'Hola, soy Códice.' });
      const input = ['/version', '!echo desde-shell', '# usar pnpm siempre', 'hola', '/cost', '/exit', ''].join('\n');
      const r = await runCli([...base], { ...opts, input });
      assert(r.stdout.includes('codice 0.1.0'), '/version');
      assert(r.stdout.includes('desde-shell'), '!shell');
      assert(fs.readFileSync(path.join(cwd, 'CODICE.md'), 'utf8').includes('usar pnpm siempre'), '#memoria');
      assert(r.stdout.includes('Hola, soy Códice.'), 'respuesta del modelo');
      assert(m.requests.at(-1).body.messages.at(-1).content.includes('<bash-output>'), 'salida del shell añadida al contexto');
      assert(m.requests.at(-1).body.messages[0].content.includes('usar pnpm siempre'), 'memoria en el system prompt');
      assert(r.stdout.includes('peticiones'), '/cost');
    });

    await t('error de conexión con mensaje accionable', async (assert) => {
      const r = await runCli(['-p', 'hola', '--base-url', 'http://127.0.0.1:9/v1', '--model', 'x'], opts);
      assert(r.status === 1, `código ${r.status}`);
      assert(/No se pudo conectar/.test(r.stderr), r.stderr);
    });
  } finally {
    await m.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
}
