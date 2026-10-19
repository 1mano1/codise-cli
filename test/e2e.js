// Pruebas de punta a punta del modo no interactivo contra el servidor LLM falso.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
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

    await t('turno: si anuncia y no actúa lo empuja; error de archivo con sugerencias; cierre "Listo"', async (assert) => {
      const proj = path.join(work, 'proyecto-turno');
      fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
      fs.mkdirSync(path.join(proj, 'config', 'pez'), { recursive: true });
      fs.writeFileSync(path.join(proj, 'config', 'pez', 'mascot.json'), '{"name":"Pez"}');
      m.push(
        { toolCalls: [{ name: 'Read', args: { file_path: 'pez/mascot.json' } }] },
        { content: 'Voy a crear el archivo notas.txt con el texto pedido.' },
        { toolCalls: [{ name: 'Write', args: { file_path: 'notas.txt', content: 'hola' } }] },
        { content: 'Listo, creé notas.txt.' },
      );
      const before = m.requests.length;
      const r = await runCli(['--yolo', ...base], { cwd: proj, home, input: 'crea notas.txt\n/exit\n' });
      const msgs = m.requests.at(-1).body.messages;
      const readErr = msgs.find((x) => x.role === 'tool' && String(x.content).includes('No existe el archivo'));
      assert(readErr && String(readErr.content).includes(path.join('config', 'pez', 'mascot.json')), `sugiere el archivo correcto: ${readErr?.content}`);
      assert(msgs.some((x) => x.role === 'user' && String(x.content).includes('did not do it')), 'empujón al anunciar sin actuar');
      assert(fs.existsSync(path.join(proj, 'notas.txt')), `terminó haciendo lo anunciado (${m.requests.length - before} peticiones)`);
      assert(/✻ Listo · .*2 herramientas/.test(r.stdout), `línea de cierre: ${r.stdout.slice(-400)}`);
    });

    await t('/provider add: acepta la clave directa o una variable, y prueba la conexión al momento', async (assert) => {
      const pHome = path.join(work, '.home-provider');
      fs.mkdirSync(pHome, { recursive: true });
      fs.writeFileSync(path.join(pHome, 'settings.json'), JSON.stringify({ onboarded: true }));
      m.requireKey = 'sk-local-abc123';
      try {
        const input = [
          `/provider add pc ${m.url}/v1 openai sk-local-abc123`,
          `/provider add mala ${m.url}/v1 openai sk-local-equivocada`,
          `/provider add var ${m.url}/v1 openai CLAVE_QUE_NO_EXISTE`,
          `/provider add sintipo ${m.url}/v1/ sk-local-abc123`,
          '/exit', '',
        ].join('\n');
        const r = await runCli([], { cwd, home: pHome, input });
        const cfg = JSON.parse(fs.readFileSync(path.join(pHome, 'settings.json'), 'utf8'));
        assert(cfg.providers.pc.apiKey === 'sk-local-abc123' && !cfg.providers.pc.apiKeyEnv, 'clave directa guardada como apiKey');
        assert(/pc añadido y conectado · 2 modelo/.test(r.stdout), `conecta al momento: ${r.stdout}`);
        assert(/mala guardado, pero no respondió: la clave no es correcta/.test(r.stdout), 'avisa si la clave es incorrecta');
        assert(cfg.providers.var.apiKeyEnv === 'CLAVE_QUE_NO_EXISTE' && /La variable CLAVE_QUE_NO_EXISTE no existe/.test(r.stdout), 'nombre de variable y aviso si no existe');
        assert(cfg.providers.sintipo.type === 'openai' && cfg.providers.sintipo.apiKey === 'sk-local-abc123' && !cfg.providers.sintipo.baseUrl.endsWith('/'), 'sin tipo: el tercer dato es la clave');
      } finally { m.requireKey = null; }
    });

    await t('pensamiento: oculto por defecto, se corta si se cicla y se puede apagar', async (assert) => {
      const block = 'Let me think about a fish shape again. A fish has a body, a tail and fins. bbbbbbbbbb bbbyyyyybb bbbyyyyybb. That is still a rectangle, let me think more carefully.\n';
      m.push(
        { reasoning: 'Pienso que el usuario quiere un saludo. Responderé breve.', content: 'Hola, ¿qué tal?' },
        { reasoning: `Primero analizo. ${block.repeat(12)}` },
        { content: 'Decidí y terminé.' },
      );
      const r = await runCli([...base], { cwd, home, input: 'hola\ndiseña algo\n/exit\n', timeout: 60000 });
      assert(r.stdout.includes('Hola, ¿qué tal?') && !r.stdout.includes('Pienso que el usuario'), 'el pensamiento no se imprime por defecto');
      assert(/se estaba repitiendo/.test(r.stdout) && r.stdout.includes('Decidí y terminé.'), `detecta el ciclo y continúa: ${r.stdout.slice(-600)}`);
      const last = m.requests.at(-1).body.messages;
      assert(last.some((x) => x.role === 'user' && /repeating the same text/.test(String(x.content))), 'le pide decidir');
      assert(!last.some((x) => String(x.content).includes('let me think more carefully')), 'el texto repetido no se guarda en el contexto');
      // thinking: false → se pide al servidor apagar el razonamiento (solo servidores propios)
      const { OpenAIClient } = await import('../src/llm/openai.js');
      m.push({ content: 'ok' });
      await new OpenAIClient({ baseUrl: `${m.url}/v1`, model: 'mock-coder:7b', thinking: false }).chat({ messages: [{ role: 'user', content: 'x' }] });
      assert(m.requests.at(-1).body.chat_template_kwargs?.enable_thinking === false, 'enable_thinking: false en la petición');
    });

    await t('compactación: /compact, respaldo sin modelo y automática al llenarse', async (assert) => {
      // manual: el resumen sustituye la conversación y conserva las tareas y archivos
      m.push({ content: 'Primera respuesta.' }, { content: '1. Primary request: probar la compactación.' }, { content: 'Sigo.' });
      let before = m.requests.length;
      let r = await runCli([...base], { ...opts, input: 'quiero probar la compactación\n/compact\nsigue\n/exit\n' });
      assert(/Conversación compactada · .+ → .+ tokens/.test(r.stdout), `aviso de compactación: ${r.stdout}`);
      const sumReq = m.requests[before + 1];
      assert(sumReq?.body.messages[1].content.includes('Pending tasks'), 'pide el resumen por secciones');
      let msgs = m.requests.at(-1).body.messages;
      assert(msgs.some((x) => String(x.content).includes('[Summary of the previous conversation]\n1. Primary request')), 'el resumen entra al contexto');
      assert(!msgs.some((x) => x.content === 'Primera respuesta.'), 'la conversación anterior se sustituyó');
      // respaldo: si el modelo falla al resumir, se compacta igual con los pedidos del usuario
      m.push({ content: 'Ok.' }, { error: { status: 400, body: 'bad request' } }, { content: 'Continúo.' });
      r = await runCli([...base], { ...opts, input: 'pedido importante\n/compact\nsigue\n/exit\n' });
      msgs = m.requests.at(-1).body.messages;
      assert(msgs.some((x) => String(x.content).includes('User requests so far') && String(x.content).includes('pedido importante')), `resumen de respaldo: ${r.stdout}${r.stderr}`);
      // automática: con una ventana pequeña se compacta sola antes de pedir
      const smallHome = path.join(work, '.home-small');
      fs.mkdirSync(smallHome, { recursive: true });
      fs.writeFileSync(path.join(smallHome, 'settings.json'), JSON.stringify({ onboarded: true, contextWindow: 2000, autoCompact: 0.5 }));
      m.push({ content: 'Uno.' }, { content: 'Dos.' }, { content: 'Resumen automático.' }, { content: 'Tres.' });
      before = m.requests.length;
      r = await runCli([...base], { cwd, home: smallHome, input: 'uno\ndos\ntres\n/exit\n' });
      assert(r.stdout.includes('Tres.') && /Conversación compactada/.test(r.stdout), `autocompactación: ${r.stdout}${r.stderr}`);
      assert(m.requests.at(-1).body.messages.some((x) => String(x.content).includes('Resumen automático.')), 'el resumen automático entra al contexto');
      assert(m.requests.length - before === 4, `peticiones: ${m.requests.length - before}`);
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
        assert(viaProxy && !viaProxy.headers['content-encoding'] && viaProxy.body?.messages, 'el backend recibe el cuerpo sin comprimir');
        // un cuerpo comprimido llega al backend descomprimido
        m.push({ content: 'ok gzip' });
        const zbody = zlib.gzipSync(JSON.stringify({ model: 'mock-coder:7b', messages: [{ role: 'user', content: 'x'.repeat(5000) }], stream: true }));
        const gz = await fetch(`http://127.0.0.1:${port}/ollama/api/chat`, { method: 'POST', headers: { Authorization: 'Bearer secreto123', 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: zbody });
        assert(gz.status === 200 && (await gz.text()).includes('ok gzip'), `proxy con gzip: ${gz.status}`);
        const lastProxied = m.requests.at(-1);
        assert(lastProxied.body?.messages?.[0].content.length === 5000 && !lastProxied.headers['content-encoding'], 'cuerpo descomprimido por codice serve');
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

    await t('sandbox real: escribe en el proyecto, no fuera, y sin red (se omite si no hay motor)', async (assert) => {
      const { detectEngine } = await import('../src/sandbox.js');
      const { engine, problem } = detectEngine();
      if (!engine) { console.log(`    (omitida: ${problem})`); return; }
      const sbHome = path.join(work, '.home-sandbox');
      const proj = path.join(work, 'proyecto-sandbox');
      fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
      fs.mkdirSync(sbHome, { recursive: true });
      fs.writeFileSync(path.join(sbHome, 'settings.json'), JSON.stringify({ onboarded: true, sandbox: { mode: 'strict' } }));
      const tag = Math.random().toString(36).slice(2, 8);
      const net = 'node -e "fetch(\'https://example.com\').then(r=>console.log(\'status\',r.status)).catch(e=>{console.error(String(e.cause&&e.cause.message||e.message));process.exit(1)})"';
      m.push(
        { toolCalls: [{ name: 'Bash', args: { command: 'echo hola > dentro.txt' } }] },
        { toolCalls: [{ name: 'Bash', args: { command: `echo x > ../fuera-${tag}.txt` } }] },
        { toolCalls: [{ name: 'Bash', args: { command: net } }] },
        { content: 'Listo con sandbox.' },
      );
      const r = await runCli([...base, '-p', 'prueba el sandbox'], { cwd: proj, home: sbHome, timeout: 240000 });
      assert(r.stdout.includes('Listo con sandbox.'), `terminó: ${r.stdout}${r.stderr}`);
      assert(fs.existsSync(path.join(proj, 'dentro.txt')) && fs.readFileSync(path.join(proj, 'dentro.txt'), 'utf8').trim() === 'hola', `${engine.name}: escribe dentro del proyecto`);
      assert(!fs.existsSync(path.join(work, `fuera-${tag}.txt`)), `${engine.name}: no escribe fuera del proyecto`);
      const results = m.requests.at(-1).body.messages.filter((x) => x.role === 'tool').map((x) => String(x.content));
      const netResult = results.at(-1) || '';
      assert(!/status 200/.test(netResult) && /sandbox blocked network/.test(netResult), `${engine.name}: sin red y el modelo lo sabe: ${netResult}`);
      if (engine.name === 'docker') { const { stopContainer } = await import('../src/sandbox.js'); await stopContainer(proj); }
    });

    await t('sandbox real: si el proxy bloquea un dominio, el diálogo permite agregarlo al proyecto', async (assert) => {
      const { detectEngine } = await import('../src/sandbox.js');
      const { engine, problem } = detectEngine();
      if (!engine) { console.log(`    (omitida: ${problem})`); return; }
      const sbHome = path.join(work, '.home-sandbox-auto');
      const proj = path.join(work, 'proyecto-sandbox-auto');
      fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
      fs.mkdirSync(sbHome, { recursive: true });
      fs.writeFileSync(path.join(sbHome, 'settings.json'), JSON.stringify({ onboarded: true, sandbox: { mode: 'auto', allowedDomains: ['registry.npmjs.org'] } }));
      m.push(
        { toolCalls: [{ name: 'Bash', args: { command: 'npm view express version --registry https://registry.yarnpkg.com' } }] },
        { content: 'Hecho.' },
      );
      const r = await runCli([...base], { cwd: proj, home: sbHome, input: 'consulta express\n1\n/exit\n', timeout: 240000 });
      assert(/El sandbox bloqueó/.test(r.stdout) && r.stdout.includes('registry.yarnpkg.com'), `diálogo del sandbox: ${r.stdout.slice(-1500)}`);
      const local = JSON.parse(fs.readFileSync(path.join(proj, '.codice', 'settings.local.json'), 'utf8'));
      assert(local.sandbox?.allowedDomains?.includes('registry.yarnpkg.com'), `dominio guardado en el proyecto: ${JSON.stringify(local)}`);
      const toolMsg = m.requests.at(-1).body.messages.filter((x) => x.role === 'tool').at(-1);
      assert(String(toolMsg?.content).includes('allowed network access to registry.yarnpkg.com'), `el modelo sabe que se permitió: ${toolMsg?.content}`);
      if (engine.name === 'docker') { const { stopContainer } = await import('../src/sandbox.js'); await stopContainer(proj); }
    });

    await t('gzip: comprime las peticiones grandes y vuelve a texto plano si el servidor no lo acepta', async (assert) => {
      const { OpenAIClient } = await import('../src/llm/openai.js');
      const { wantsGzip, gzipRejected } = await import('../src/llm/compress.js');
      assert(wantsGzip({}, { cloud: true, baseUrl: 'https://api.anthropic.com/v1' }), 'Anthropic: sí');
      assert(!wantsGzip({}, { cloud: true, baseUrl: 'https://api.openai.com/v1' }), 'otras nubes: solo si se activa');
      assert(wantsGzip({ compressRequests: true }, { cloud: true, baseUrl: 'https://api.openai.com/v1' }), 'se puede activar');
      assert(wantsGzip({}, { type: 'codice', baseUrl: 'http://192.168.1.5:8787' }), 'PC remota: sí');
      assert(!wantsGzip({}, { type: 'ollama', baseUrl: 'http://localhost:11434' }), 'servidor en esta PC: no');
      assert(!wantsGzip({ compressRequests: false }, { cloud: true, baseUrl: 'https://x.ai' }), 'se puede apagar');
      const big = [{ role: 'user', content: 'contexto repetido '.repeat(2000) }];
      m.push({ content: 'comprimido' });
      const client = new OpenAIClient({ baseUrl: `${m.url}/v1`, model: 'mock-coder:7b', gzip: true });
      let r = await client.chat({ messages: big });
      let q = m.requests.at(-1);
      assert(r.content === 'comprimido' && q.headers['content-encoding'] === 'gzip', 'se envía con gzip');
      assert(q.bytes < JSON.stringify(q.body).length / 5, `viaja al menos 5 veces más ligero: ${q.bytes} B`);
      m.rejectGzip = true;
      m.push({ content: 'sin comprimir' });
      try { r = await client.chat({ messages: big }); } finally { m.rejectGzip = false; }
      q = m.requests.at(-1);
      assert(r.content === 'sin comprimir' && !q.headers['content-encoding'] && m.requests.at(-2).rejected, 'reintento sin gzip');
      assert(gzipRejected(m.url), 'recuerda que ese servidor no acepta gzip');
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
