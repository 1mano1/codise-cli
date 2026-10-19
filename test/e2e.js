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
      assert(last.role === 'tool' && last.content.startsWith('Permission denied'), `resultado: ${last.content}`);
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
      const input = ['/version', '!echo desde-shell', '# usar pnpm siempre', 'hola', '/cost', '/usage', '/exit', ''].join('\n');
      const r = await runCli([...base], { ...opts, input });
      assert(r.stdout.includes('codice 0.1.0'), '/version');
      assert(r.stdout.includes('desde-shell'), '!shell');
      assert(fs.readFileSync(path.join(cwd, 'CODICE.md'), 'utf8').includes('usar pnpm siempre'), '#memoria');
      assert(r.stdout.includes('Hola, soy Códice.'), 'respuesta del modelo');
      assert(m.requests.at(-1).body.messages.at(-1).content.includes('<bash-output>'), 'salida del shell añadida al contexto');
      assert(m.requests.at(-1).body.messages[0].content.includes('usar pnpm siempre'), 'memoria en el system prompt');
      assert(r.stdout.includes('peticiones'), '/cost');
      assert(r.stdout.includes('Esta sesión') && r.stdout.includes('Hoy'), '/usage');
    });

    await t('PC remota: codice serve + codice connect + tarea a través del proxy', async (assert) => {
      const port = 20000 + Math.floor(Math.random() * 20000);
      const pcHome = path.join(work, '.home-pc');
      const server = spawn(process.execPath, [BIN, 'serve', '--port', String(port), '--host', '127.0.0.1', '--token', 'secreto123', '--backend', 'ollama', '--backend-url', m.url], { env: { ...process.env, CODICE_HOME: pcHome, NO_COLOR: '1' } });
      let log = '';
      server.stdout.on('data', (d) => { log += d; });
      server.stderr.on('data', (d) => { log += d; });
      try {
        const t0 = Date.now();
        while (!log.includes('codice connect') && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 100));
        assert(log.includes('codice connect'), `serve no arrancó: ${log}`);
        const laptop = { cwd, home: path.join(work, '.home-laptop') };
        const bad = await runCli(['connect', `http://127.0.0.1:${port}`, '--token', 'malo'], laptop);
        assert(bad.status === 1 && /Token inválido/.test(bad.stdout + bad.stderr), 'token incorrecto rechazado');
        const ok = await runCli(['connect', `http://127.0.0.1:${port}`, '--token', 'secreto123', '--name', 'pc-casa'], laptop);
        assert(ok.status === 0, `connect falló: ${ok.stdout}${ok.stderr}`);
        const cfg = JSON.parse(fs.readFileSync(path.join(laptop.home, 'settings.json'), 'utf8'));
        assert(cfg.provider === 'pc-casa' && cfg.providers['pc-casa'].type === 'codice', 'proveedor guardado');
        m.push({ content: 'Respondo desde la PC.' });
        const before = m.requests.length;
        const r = await runCli(['-p', 'hola'], laptop);
        assert(r.stdout.includes('Respondo desde la PC.'), `respuesta: ${r.stdout} ${r.stderr}`);
        const viaProxy = m.requests.slice(before).find((q) => q.url === '/api/chat');
        assert(viaProxy && !viaProxy.headers.authorization, 'petición llegó al backend Ollama sin el token');
        const noAuth = await fetch(`http://127.0.0.1:${port}/codice/usage`);
        assert(noAuth.status === 401, `/codice/usage pide token: ${noAuth.status}`);
        const su = await (await fetch(`http://127.0.0.1:${port}/codice/usage`, { headers: { Authorization: 'Bearer secreto123' } })).json();
        assert(su.today?.requests >= 1 && su.today.input >= 100 && su.today.output >= 20, `consumo servido: ${JSON.stringify(su.today)}`);
        const u = await runCli([], { ...laptop, input: '/usage\n/exit\n' });
        assert(/Proveedor/.test(u.stdout) && /total/.test(u.stdout) && /tu PC/.test(u.stdout), `/usage con PC remota: ${u.stdout}`);
      } finally {
        server.kill();
      }
    });

    await t('modo lector de pantalla: frases completas, sin dibujos', async (assert) => {
      m.push({ toolCalls: [{ name: 'LS', args: {} }] }, { content: 'Listo.' });
      const r = await runCli(['--screen-reader', '--yolo', ...base], { ...opts, input: 'lista\n/exit\n' });
      assert(r.stdout.includes('Códice 0.1.0. Agente de programación open source.'), 'banner en texto');
      assert(!/[█╭╰│]/.test(r.stdout), 'sin bloques ni cajas');
      assert(/Herramienta LS, correcta/.test(r.stdout), 'resultado de herramienta como frase');
    });

    await t('interfaz en inglés: ayuda, consola y errores', async (assert) => {
      const enHome = path.join(work, '.home-en');
      fs.mkdirSync(enHome, { recursive: true });
      fs.writeFileSync(path.join(enHome, 'settings.json'), JSON.stringify({ language: 'en', onboarded: true }));
      const en = { cwd, home: enHome };
      const help = await runCli(['--help'], en);
      assert(help.stdout.includes('Interactive console'), '--help en inglés');
      const r = await runCli([...base], { ...en, input: '/help\n/exit\n' });
      assert(r.stdout.includes('/help commands') && r.stdout.includes('Show commands and shortcuts'), 'consola en inglés');
      assert(!r.stdout.includes('Muestra los comandos'), 'sin textos en español');
      const err = await runCli(['-p', 'hi', '--base-url', 'http://127.0.0.1:9/v1', '--model', 'x'], en);
      assert(/Could not connect/.test(err.stderr), `error en inglés: ${err.stderr}`);
    });

    await t('detector de bucles: bloquea llamadas repetidas y detiene la tarea', async (assert) => {
      // 2 se ejecutan, las 3 siguientes se bloquean y la tarea se detiene
      for (let i = 0; i < 5; i++) m.push({ toolCalls: [{ name: 'LS', args: {} }] });
      const r = await runCli(['-p', 'lista', '--yolo', ...base], opts);
      assert(r.stderr.includes('Detuve la tarea'), `salida: ${r.stderr}`);
      assert(r.stderr.includes('Llamada repetida bloqueada'), 'llamada repetida marcada');
    });

    await t('-p no se cuelga si stdin queda abierto sin datos', async (assert) => {
      m.push({ content: 'Respuesta sin stdin.' });
      const r = await new Promise((resolve) => {
        const p = spawn(process.execPath, [BIN, '-p', 'hola', ...base], { cwd, env: { ...process.env, CODICE_HOME: home, NO_COLOR: '1' } });
        let stdout = '';
        p.stdout.on('data', (d) => { stdout += d; });
        const t0 = setTimeout(() => { p.kill(); resolve({ status: 'timeout', stdout }); }, 15000);
        p.on('close', (status) => { clearTimeout(t0); resolve({ status, stdout }); });
        // stdin queda abierto a propósito
      });
      assert(r.status === 0 && r.stdout.includes('Respuesta sin stdin.'), `estado ${r.status}: ${r.stdout}`);
    });

    await t('memoria entre sesiones: la actividad anterior llega a la sesión nueva', async (assert) => {
      m.push(
        { toolCalls: [{ name: 'Write', args: { file_path: 'utils.js', content: 'export const suma = (a, b) => a + b;\n' } }] },
        { content: 'Creé utils.js con la función suma.' },
      );
      await runCli(['-p', 'crea utils.js con una función suma', '--yolo', ...base], opts);
      m.push({ content: 'Antes creamos utils.js.' });
      await runCli(['-p', '¿qué hicimos antes?', ...base], opts);
      const sys = m.requests.at(-1).body.messages[0].content;
      assert(sys.includes('Recent activity in this project'), 'sección de actividad reciente');
      assert(sys.includes('crea utils.js con una función suma') && sys.includes('files changed: utils.js'), `pedido y archivo anteriores: ${sys.slice(-500)}`);
    });

    await t('Remember: el agente guarda una nota en CODICE.md y la siguiente sesión la conoce', async (assert) => {
      m.push(
        { toolCalls: [{ name: 'Remember', args: { note: 'Las pruebas se ejecutan con npm test' } }] },
        { content: 'Anotado.' },
      );
      await runCli(['-p', 'recuerda cómo se prueban', ...base], opts);
      assert(fs.readFileSync(path.join(cwd, 'CODICE.md'), 'utf8').includes('- Las pruebas se ejecutan con npm test'), 'nota en CODICE.md');
      m.push({ content: 'ok' });
      await runCli(['-p', 'hola', ...base], opts);
      assert(m.requests.at(-1).body.messages[0].content.includes('Las pruebas se ejecutan con npm test'), 'la nota llega al modelo');
    });

    await t('recuperación: reintenta fallos pasajeros del modelo', async (assert) => {
      m.push({ error: { status: 503, body: 'overloaded' } }, { content: 'Respondí al segundo intento.' });
      const r = await runCli(['-p', 'hola', ...base], opts);
      assert(r.status === 0 && r.stdout.includes('Respondí al segundo intento.'), `salida: ${r.stdout} ${r.stderr}`);
      assert(/Reintento 1\/3/.test(r.stderr), 'avisa del reintento');
    });

    await t('recuperación: un error de herramienta llega con la indicación de investigar y seguir', async (assert) => {
      m.push({ toolCalls: [{ name: 'Read', args: { file_path: 'no-existe.js' } }] }, { content: 'El archivo no existe; lo creo.' });
      await runCli(['-p', 'lee no-existe.js', ...base], opts);
      const toolMsg = m.requests.at(-1).body.messages.at(-1);
      assert(toolMsg.role === 'tool' && toolMsg.content.includes('Find the cause'), `resultado: ${toolMsg.content}`);
    });

    await t('error de conexión con mensaje accionable', async (assert) => {
      const r = await runCli(['-p', 'hola', '--base-url', 'http://127.0.0.1:9/v1', '--model', 'x'], opts);
      assert(r.status === 1, `código ${r.status}`);
      assert(/No pude conectar/.test(r.stderr), r.stderr);
    });
  } finally {
    await m.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
}
