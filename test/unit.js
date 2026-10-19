// Pruebas unitarias de los módulos principales.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'codice-unit-'));

function makePNG(w, h, pixel) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 4 + 1) + 1 + x * 4;
    const [r, g, b, a] = pixel(x, y);
    raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
  }
  const crc = (buf) => { let crc = 0xffffffff; for (const byte of buf) { let c = (crc ^ byte) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export async function unitTests(t) {
  const { parseFrontmatter, toList } = await import('../src/util/frontmatter.js');
  const { globToRegex, makeMatcher } = await import('../src/util/glob.js');
  const { matchRule, suggestRule, Permissions } = await import('../src/permissions.js');
  const { parseTarget } = await import('../src/llm/index.js');
  const { TagSplitter, stripThinking } = await import('../src/llm/stream.js');
  const { parseTextToolCalls, toPromptMessages } = await import('../src/llm/textTools.js');
  const theme = await import('../src/ui/theme.js');
  const mascot = await import('../src/ui/mascot.js');
  const { pngToMascot } = await import('../src/util/png.js');
  const { runHooks } = await import('../src/hooks.js');
  const { Checkpoints } = await import('../src/session.js');
  const { expandCommand } = await import('../src/resources.js');
  const { BUILTIN_TOOLS, validateArgs, parseToolArgs } = await import('../src/tools/index.js');
  const { DEFAULTS, deepMerge } = await import('../src/config.js');

  await t('frontmatter: valores, listas y texto plegado', async (assert) => {
    const { data, body } = parseFrontmatter('---\nname: explore\ntools: Read, Grep\nlist:\n  - a\n  - b\ndescription: >\n  línea uno\n  línea dos\nflag: true\n---\nCuerpo');
    assert(data.name === 'explore' && data.flag === true, JSON.stringify(data));
    assert(toList(data.tools).join() === 'Read,Grep', 'tools');
    assert(data.list.join() === 'a,b', 'lista');
    assert(data.description === 'línea uno línea dos', `plegado: ${data.description}`);
    assert(body === 'Cuerpo', 'cuerpo');
  });

  await t('glob: **, llaves y nombres de archivo', async (assert) => {
    assert(globToRegex('**/*.ts').test('src/a/b.ts') && globToRegex('**/*.ts').test('b.ts'), '**');
    assert(globToRegex('src/**/*.{js,jsx}').test('src/x/y.jsx') && !globToRegex('src/**/*.{js,jsx}').test('lib/y.js'), 'llaves');
    assert(makeMatcher('*.md')('docs/readme.md') && !makeMatcher('*.md')('docs/readme.mdx'), 'basename');
  });

  await t('permisos: reglas, sugerencias y modos', async (assert) => {
    assert(matchRule('Bash(npm test:*)', 'Bash', 'npm test -- --watch'), 'prefijo');
    assert(!matchRule('Bash(npm test:*)', 'Bash', 'npm install'), 'no coincide');
    assert(matchRule('mcp__github__*', 'mcp__github__create_issue', null), 'comodín de nombre');
    assert(suggestRule({ name: 'Bash' }, 'npm install express') === 'Bash(npm install:*)', 'sugerencia');
    assert(suggestRule({ name: 'Bash' }, 'ls -la') === 'Bash(ls:*)', 'sugerencia con flag');
    const rt = { settings: { permissions: { allow: [], deny: ['Bash(rm -rf:*)'] } }, permissionMode: 'acceptEdits', projectRoot: tmp() };
    const p = new Permissions(rt);
    assert((await p.check({ name: 'Edit', edits: true }, {}, { ui: { interactive: false } })).allowed, 'acceptEdits permite editar');
    assert(!(await p.check({ name: 'Bash', permissionKey: (a) => a.command }, { command: 'rm -rf /' }, { ui: { interactive: true } })).allowed, 'deny gana');
    rt.permissionMode = 'plan';
    assert(!(await p.check({ name: 'Write', edits: true }, {}, { ui: {} })).allowed, 'plan bloquea escritura');
    assert((await p.check({ name: 'Read', readOnly: true }, {}, { ui: {} })).allowed, 'plan permite lectura');
  });

  await t('proveedor:modelo con modelos que contienen ":"', async (assert) => {
    const s = deepMerge(DEFAULTS, { providers: { 'pc-casa': { type: 'codice', baseUrl: 'http://x' } } });
    assert(JSON.stringify(parseTarget('pc-casa:qwen2.5:7b', s)) === '{"provider":"pc-casa","model":"qwen2.5:7b"}', 'con proveedor');
    assert(JSON.stringify(parseTarget('qwen2.5:7b', s)) === '{"provider":"local","model":"qwen2.5:7b"}', 'sin proveedor');
  });

  await t('stream: separa <think> y oculta <tool_call> aunque lleguen partidos', async (assert) => {
    let text = '', reasoning = '';
    const sp = new TagSplitter({ onText: (x) => { text += x; }, onReasoning: (x) => { reasoning += x; } });
    for (const ch of '<thi|nk>pienso</th|ink>Hola <tool_|call>{"name":"X"}</tool_call> fin'.split('|')) sp.push(ch);
    sp.flush();
    assert(reasoning === 'pienso' && text === 'Hola  fin', `${JSON.stringify(text)} ${JSON.stringify(reasoning)}`);
    assert(stripThinking('previo</think>respuesta') === 'respuesta', 'cierre huérfano');
  });

  await t('modo prompt: JSON tolerante y conversión de mensajes', async (assert) => {
    const p = parseTextToolCalls('ok <tool_call>```json\n{"name":"Read","arguments":{"file_path":"x",}}\n```</tool_call>');
    assert(p.calls.length === 1 && p.calls[0].name === 'Read' && p.cleaned === 'ok', JSON.stringify(p));
    const msgs = toPromptMessages([{ role: 'assistant', content: '', tool_calls: [{ id: '1', function: { name: 'Read', arguments: '{}' } }] }, { role: 'tool', name: 'Read', content: 'a' }, { role: 'tool', name: 'LS', content: 'b' }]);
    assert(msgs.length === 2 && msgs[1].role === 'user' && msgs[1].content.includes('<tool_result name="LS">'), 'resultados agrupados');
  });

  await t('herramientas: validación y argumentos', async (assert) => {
    const read = BUILTIN_TOOLS.find((x) => x.name === 'Read');
    assert(validateArgs(read, {}) === 'Falta el parámetro obligatorio "file_path"', 'requerido');
    const args = { file_path: 'a', offset: '10' };
    validateArgs(read, args);
    assert(args.offset === 10, 'coerción de número');
    assert(parseToolArgs('{"a":1,}').a === 1, 'JSON con coma final');
  });

  await t('Edit: coincidencia tolerante y CRLF preservado', async (assert) => {
    const dir = tmp();
    const f = path.join(dir, 'a.js');
    fs.writeFileSync(f, 'const a = 1;\r\nfunction f() {\r\n  return a;  \r\n}\r\n');
    const edit = BUILTIN_TOOLS.find((x) => x.name === 'Edit');
    const read = BUILTIN_TOOLS.find((x) => x.name === 'Read');
    const ctx = { runtime: { readFiles: new Set(), settings: {} }, cwd: dir, ui: { diff() {} } };
    let err = null;
    try { await edit.run({ file_path: 'a.js', old_string: 'return a;', new_string: 'return 2;' }, ctx); } catch (e) { err = e.message; }
    assert(/Read/.test(err || ''), 'exige leer antes');
    await read.run({ file_path: 'a.js' }, ctx);
    await edit.run({ file_path: 'a.js', old_string: '  return a;\n}', new_string: '  return a * 2;\n}' }, ctx);
    assert(fs.readFileSync(f, 'utf8') === 'const a = 1;\r\nfunction f() {\r\n  return a * 2;\r\n}\r\n', JSON.stringify(fs.readFileSync(f, 'utf8')));
  });

  await t('temas: todos los incluidos cumplen contraste WCAG AA', async (assert) => {
    for (const [id, th] of Object.entries(theme.BUILTIN_THEMES)) {
      const w = theme.validateContrast(th.tokens);
      assert(!w.length, `${id}: ${w[0]}`);
    }
    const hc = theme.BUILTIN_THEMES['alto-contraste'].tokens;
    assert(theme.contrast(hc['text/dim'], hc['bg/elevated']) >= 7, 'alto contraste ≥ 7:1');
  });

  await t('temas: degradado a 256 y 16 colores, y sin color', async (assert) => {
    theme.setTheme('brasa');
    theme.setColorLevel(2);
    assert(/38;5;\d+/.test(theme.style('x', { fg: 'accent/primary' })), '256');
    theme.setColorLevel(1);
    assert(/\x1b\[(3|9)\dm/.test(theme.style('x', { fg: 'accent/primary' })), '16');
    theme.setColorLevel(0);
    assert(theme.style('x', { fg: 'accent/primary', bold: true }) === 'x', 'sin color');
    theme.setColorLevel(3);
  });

  await t('mascotas: incluidas válidas, render y estados', async (assert) => {
    const all = mascot.loadMascots();
    for (const id of ['chispa', 'ajolote', 'nahual', 'xolo']) assert(all[id] && !mascot.validateMascot(all[id]), `${id} válida`);
    const m = all.chispa;
    assert(mascot.renderMascot(m).length === Math.ceil(m.pixels.length / 2), 'medios bloques: 2 píxeles por fila');
    assert(mascot.mascotPalette(m, 'error')[m.eyes] === '#E0303A', 'estado error');
    assert(mascot.validateMascot({ pixels: ['ab'], palette: { a: '#000000' } }).includes('"b"'), 'detecta color faltante');
  });

  await t('PNG → mascota', async (assert) => {
    const f = path.join(tmp(), 'gato.png');
    fs.writeFileSync(f, makePNG(8, 8, (x, y) => (x === 0 || y === 0 ? [0, 0, 0, 0] : y === 3 && (x === 2 || x === 5) ? [0, 0, 0, 255] : [255, 122, 26, 255])));
    const m = pngToMascot(f, { name: 'Gato' });
    assert(m.pixels.length === 8 && m.pixels[0] === '........', m.pixels.join('/'));
    assert(Object.keys(m.palette).length === 2 && !mascot.validateMascot(m), JSON.stringify(m.palette));
  });

  await t('hooks: código 2 bloquea y el matcher filtra', async (assert) => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'block.js'), 'process.stderr.write("prohibido"); process.exit(2);');
    const cfg = { PreToolUse: [{ matcher: 'Bash|Edit', hooks: [{ command: 'node block.js' }] }] };
    const r1 = await runHooks(cfg, 'PreToolUse', { tool_name: 'Bash' }, { target: 'Bash', cwd: dir });
    const r2 = await runHooks(cfg, 'PreToolUse', { tool_name: 'Read' }, { target: 'Read', cwd: dir });
    assert(r1.blocked && r1.reason === 'prohibido', JSON.stringify(r1));
    assert(!r2.blocked, 'Read no coincide');
  });

  await t('checkpoints: /rewind restaura y borra archivos nuevos', async (assert) => {
    const dir = tmp();
    const a = path.join(dir, 'a.txt'), b = path.join(dir, 'b.txt');
    fs.writeFileSync(a, 'original');
    const cp = new Checkpoints();
    cp.beginTurn(0, 'cambio');
    cp.snapshot(a); cp.snapshot(b);
    fs.writeFileSync(a, 'nuevo'); fs.writeFileSync(b, 'creado');
    const r = cp.rewind(0);
    assert(fs.readFileSync(a, 'utf8') === 'original' && !fs.existsSync(b) && r.restored.length === 2, 'restaurado');
  });

  await t('comandos personalizados: $ARGUMENTS, $1 y !`cmd`', async (assert) => {
    const out = await expandCommand({ template: 'Revisa $1 en modo $2\n!`git status`\nTodo: $ARGUMENTS' }, 'src rápido', { runShell: async () => ({ output: 'M a.js\n' }) });
    assert(out === 'Revisa src en modo rápido\nM a.js\nTodo: src rápido', JSON.stringify(out));
  });

  await t('agentes incluidos: 10 expertos con descripción', async (assert) => {
    const { loadAgents } = await import('../src/resources.js');
    const agents = loadAgents({ projectRoot: tmp(), plugins: [], compat: false });
    const expected = ['general-purpose', 'explore', 'plan', 'code-reviewer', 'debugger', 'test-writer', 'refactorer', 'security-auditor', 'docs-writer', 'frontend'];
    for (const n of expected) assert(agents[n]?.description && agents[n].prompt, `falta ${n}`);
    assert(agents.explore.tools.every((x) => ['Read', 'Glob', 'Grep', 'LS'].includes(x)), 'explore solo lectura');
  });

  await t('MCP: servidor stdio de prueba', async (assert) => {
    const { McpManager } = await import('../src/mcp.js');
    const mgr = new McpManager({ cwd: tmp() });
    await mgr.startAll({ eco: { command: process.execPath, args: [path.join(ROOT, 'test', 'fixtures', 'echo-mcp.js')] } });
    try {
      const tools = mgr.tools();
      assert(tools.map((x) => x.name).join() === 'mcp__eco__echo,mcp__eco__add', tools.map((x) => x.name).join());
      assert((await tools[1].run({ a: 2, b: 3 }, {})).content === '5', 'tools/call');
      assert(tools[0].readOnly, 'readOnlyHint');
      assert((await mgr.prompts()[0].client.getPrompt('saludo', { nombre: 'Ana' })) === 'Saluda a Ana', 'prompts/get');
    } finally {
      mgr.stopAll();
    }
  });

  await t('modelos locales: GGUF, Ollama, divididos y formatos no compatibles', async (assert) => {
    const M = await import('../src/local/models.js');
    const dir = tmp();
    const big = (p, mb = 25) => { fs.mkdirSync(path.dirname(p), { recursive: true }); const fd = fs.openSync(p, 'w'); fs.ftruncateSync(fd, mb * 1024 * 1024); fs.closeSync(fd); };
    big(path.join(dir, 'qwen-coder-7b-q4_k_m.gguf'));
    big(path.join(dir, 'sub', 'llama-3-8b.gguf'));
    big(path.join(dir, 'mmproj-vision.gguf'));
    big(path.join(dir, 'grande-00001-of-00002.gguf'));
    big(path.join(dir, 'grande-00002-of-00002.gguf'));
    big(path.join(dir, 'tiny.gguf'), 1);
    big(path.join(dir, 'hf-model', 'model.safetensors'), 1);
    // Ollama: manifiesto → blob
    const oll = path.join(dir, 'ollama');
    big(path.join(oll, 'blobs', 'sha256-abc123'));
    fs.mkdirSync(path.join(oll, 'manifests', 'registry.ollama.ai', 'library', 'qwen2.5-coder'), { recursive: true });
    fs.writeFileSync(path.join(oll, 'manifests', 'registry.ollama.ai', 'library', 'qwen2.5-coder', '7b'), JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:abc123', size: 26214400 }] }));
    const prev = process.env.OLLAMA_MODELS;
    process.env.OLLAMA_MODELS = oll;
    try {
      const ids = M.scanModels({ modelDirs: [dir] }).map((m) => m.id).sort();
      assert(ids.includes('qwen-coder-7b-q4_k_m') && ids.includes('llama-3-8b'), `GGUF: ${ids}`);
      assert(ids.includes('qwen2.5-coder:7b'), `Ollama: ${ids}`);
      assert(ids.includes('grande-00001-of-00002') && !ids.includes('grande-00002-of-00002'), 'solo la primera parte de un modelo dividido');
      assert(!ids.some((i) => /mmproj|tiny/.test(i)), 'sin proyectores de visión ni archivos diminutos');
      assert(M.resolveModelFile({ modelDirs: [dir] }, 'llama-3-8b')?.file.endsWith('llama-3-8b.gguf'), 'resuelve por id');
      assert(M.unsupportedModels({ modelDirs: [dir] }).some((u) => u.kind === 'safetensors'), 'detecta safetensors no compatibles');
    } finally {
      if (prev === undefined) delete process.env.OLLAMA_MODELS; else process.env.OLLAMA_MODELS = prev;
    }
  });

  await t('memoria: CODICE.md y archivos de contexto de otros agentes', async (assert) => {
    const { loadMemory } = await import('../src/memory.js');
    const root = tmp();
    const w = (rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
    w('CODICE.md', 'usa pnpm');
    w('CLAUDE.md', 'claude');
    w('AGENTS.md', 'agents');
    w('GEMINI.md', 'gemini');
    w('.github/copilot-instructions.md', 'copilot');
    w('.cursor/rules/estilo.mdc', '---\nglobs: "*.ts"\n---\ncursor rule');
    w('.clinerules', 'cline');
    const mem = loadMemory(root, root, { compat: true });
    const agents = mem.map((m) => m.agent);
    for (const a of ['Códice', 'Claude Code', 'Codex / OpenCode', 'Gemini CLI', 'GitHub Copilot', 'Cursor', 'Cline']) assert(agents.includes(a), `falta ${a}: ${agents}`);
    assert(mem.find((m) => m.agent === 'Cursor').content.trim() === 'cursor rule', 'sin frontmatter en reglas de Cursor');
    assert(loadMemory(root, root, { compat: false }).every((m) => m.agent === 'Códice'), 'compat desactivado: solo CODICE.md');
  });

  await t('diff: en archivos nuevos todas las líneas (también las vacías) son añadidas', async (assert) => {
    const { diffLines } = await import('../src/ui/output.js');
    const lines = diffLines('', '## Título\n\n### Sección\n- uno').map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    assert(lines.length === 4, `4 líneas: ${lines.length}`);
    lines.forEach((l, i) => assert(new RegExp(`^\\s*${i + 1} \\+`).test(l), `línea ${i + 1} con número y +: "${l}"`));
  });

  await t('modo ligero: herramientas sin textos de ayuda y con lista de agentes', async (assert) => {
    const { toolSpec, BUILTIN_TOOLS } = await import('../src/tools/index.js');
    const rt = { agents: { explore: { name: 'explore', description: 'Fast read-only agent to find files, symbols and how things work across a codebase.' } }, skills: {} };
    const read = toolSpec(BUILTIN_TOOLS.find((x) => x.name === 'Read'), rt, { lean: true });
    assert(!JSON.stringify(read.parameters).includes('"description"'), 'parámetros sin descripción');
    assert(read.parameters.required.includes('file_path'), 'se conserva el esquema');
    const task = toolSpec(BUILTIN_TOOLS.find((x) => x.name === 'Task'), rt, { lean: true });
    assert(task.description.includes('- explore:'), 'la lista de agentes se conserva');
    const full = toolSpec(BUILTIN_TOOLS.find((x) => x.name === 'Read'), rt, { lean: false });
    assert(JSON.stringify(read).length < JSON.stringify(full).length * 0.75, 'al menos 25 % más corto');
  });

  await t('motor local: paquetes por sistema y nombre de repo de Hugging Face', async (assert) => {
    const E = await import('../src/local/engine.js');
    const HF = await import('../src/local/hf.js');
    const pkgs = E.enginePackages();
    assert(pkgs.length >= 1 && pkgs.every((p) => p.url.includes(E.LLAMA_VERSION)), 'versión fija');
    assert(HF.parseRepo('https://huggingface.co/Imanol11/qwen3b-int4-Octuma/tree/main') === 'Imanol11/qwen3b-int4-Octuma', 'URL completa');
    assert(HF.parseRepo('Qwen/Qwen2.5-Coder-7B-Instruct-GGUF') === 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF', 'usuario/repo');
    assert(HF.parseRepo('no valido') === null, 'inválido');
  });

  await t('plugins: instala el ejemplo y carga sus recursos', async (assert) => {
    const { HOME } = await import('../src/config.js');
    assert(HOME.startsWith(os.tmpdir()), `CODICE_HOME debe ser temporal en las pruebas: ${HOME}`);
    if (!HOME.startsWith(os.tmpdir())) return;
    const out = await import('../src/plugins.js');
    const res = await import('../src/resources.js');
    const p = out.installPlugin(path.join(ROOT, 'examples', 'plugin-ejemplo'));
    const plugins = out.listPlugins({ enabledPlugins: {} });
    const opts = { projectRoot: tmp(), plugins, compat: false };
    assert(p.name === 'ejemplo' && plugins.length === 1, 'instalado');
    assert(res.loadSkills(opts)['ejemplo:commit-message'], 'skill del plugin');
    assert(res.loadCommands(opts)['ejemplo:review'], 'comando del plugin');
    assert(res.loadAgents(opts)['ejemplo:translator'], 'agente del plugin');
    assert(out.pluginHooks(plugins[0]).PostToolUse?.[0]?.pluginRoot, 'hooks con raíz del plugin');
  });

  await t('sandbox: argumentos de cada motor, bloqueos, proxy de dominios y permisos', async (assert) => {
    const S = await import('../src/sandbox.js');
    const http = await import('node:http');
    const b = S.bwrapArgs({ writable: ['/home/u/p', '/home/u/.codice/sandbox/tmp'], cwd: '/home/u/p', network: false });
    assert(b.join(' ').includes('--ro-bind / /') && b.join(' ').includes('--bind /home/u/p /home/u/p') && b.includes('--unshare-net'), `bwrap: ${b.join(' ')}`);
    assert(!S.bwrapArgs({ writable: [], cwd: '/', network: true }).includes('--unshare-net'), 'bwrap con red permitida');
    const prof = S.seatbeltProfile({ writable: ['/Users/u/p'], proxyPort: 4321 });
    assert(prof.includes('(deny file-write*)') && prof.includes('(subpath "/Users/u/p")') && prof.includes('(deny network*)') && prof.includes('localhost:4321'), 'perfil de macOS');
    assert(S.containerPath('/a/proj', '/a/proj/src/x') === '/workspace/src/x' && S.containerPath('/a/proj', '/otro') === '/workspace', 'ruta dentro del contenedor');
    assert(S.detectBlock('npm ERR! getaddrinfo ENOTFOUND registry.npmjs.org', { code: 1 })?.host === 'registry.npmjs.org', 'red bloqueada con host');
    assert(S.detectBlock("curl: (6) Could not resolve host: example.com", { code: 6 })?.kind === 'network', 'curl sin red');
    assert(S.detectBlock('TypeError: fetch failed', { code: 1 })?.kind === 'network', 'fetch de Node sin red (macOS)');
    assert(S.detectBlock("touch: cannot touch '/etc/x': Read-only file system", { code: 1 })?.path === '/etc/x', 'escritura bloqueada con ruta');
    assert(S.detectBlock('ENOTFOUND x.com', { code: 0 }) === null && S.detectBlock('test failed: expected 2', { code: 1 }) === null, 'sin falsos positivos');
    assert(S.hostAllowed('registry.npmjs.org', ['npmjs.org']) && !S.hostAllowed('evilnpmjs.org', ['npmjs.org']) && !S.hostAllowed('github.com', []), 'dominios permitidos');
    // proxy: deja pasar solo lo permitido
    const target = http.createServer((q, r) => r.end('hola')); await new Promise((r) => target.listen(0, '127.0.0.1', r));
    const p = await S.startProxy(() => ['127.0.0.1']);
    const viaProxy = (host) => new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: p.port, method: 'GET', path: `http://${host}:${target.address().port}/` }, (r) => { let d = ''; r.on('data', (x) => { d += x; }); r.on('end', () => resolve({ status: r.statusCode, d })); });
      req.on('error', (e) => resolve({ status: 0, d: e.message })); req.end();
    });
    const ok = await viaProxy('127.0.0.1');
    const no = await viaProxy('localhost');
    assert(ok.status === 200 && ok.d === 'hola', `proxy permite: ${ok.status}`);
    assert(no.status === 403 && /Blocked by Codice sandbox: host localhost/.test(no.d), `proxy bloquea: ${no.status}`);
    S.stopProxy(); target.close();
    // permisos: con el sandbox activo, Bash no pregunta (motor forzado para la prueba)
    const { Permissions } = await import('../src/permissions.js');
    const prev = process.env.CODICE_SANDBOX_ENGINE;
    process.env.CODICE_SANDBOX_ENGINE = 'bwrap';
    try {
      const rt = { settings: { sandbox: { mode: 'auto' }, permissions: {} }, permissionMode: 'default' };
      const bash = { name: 'Bash', sandboxable: true, permissionKey: (a) => a.command };
      const r1 = await new Permissions(rt).check(bash, { command: 'npm test' }, { ui: null });
      assert(r1.allowed && r1.sandboxed, 'Bash permitido sin preguntar dentro del sandbox');
      rt.settings.sandbox.mode = 'off';
      const r2 = await new Permissions(rt).check(bash, { command: 'npm test' }, { ui: null });
      assert(!r2.allowed, 'sin sandbox vuelve a pedir permiso');
    } finally { if (prev == null) delete process.env.CODICE_SANDBOX_ENGINE; else process.env.CODICE_SANDBOX_ENGINE = prev; }
  });

  await t('agente: detecta cuando anuncia una acción y no la hace; sugiere archivos con el mismo nombre', async (assert) => {
    const { announcesAction } = await import('../src/agent/agent.js');
    assert(announcesAction('Voy a crear una nueva versión del archivo mascot.json con estos detalles.'), 'voy a…');
    assert(announcesAction('Aquí está el contenido:\n```json\n{}\n```\nA continuación, vamos a reemplazar el archivo existente con este nuevo contenido.'), 'a continuación…');
    assert(announcesAction("Let me update the config file."), 'let me…');
    assert(!announcesAction('¿Podrías confirmar el nombre del archivo?'), 'una pregunta no cuenta');
    assert(!announcesAction('Listo: creé memory.js y las pruebas pasan.'), 'un resumen final no cuenta');
    const { findSimilar } = await import('../src/tools/files.js');
    const root = tmp();
    fs.mkdirSync(path.join(root, 'mascots', 'pez'), { recursive: true });
    fs.writeFileSync(path.join(root, 'mascots', 'pez', 'mascot.json'), '{}');
    fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'x', 'mascot.json'), '{}');
    const found = findSimilar(path.join('C:', 'otro', 'pez', 'mascot.json'), [root]);
    assert(found.length === 1 && found[0].endsWith(path.join('pez', 'mascot.json')), `encuentra el archivo (sin node_modules): ${found}`);
  });

  await t('compactación: la transcripción respeta el presupuesto', async (assert) => {
    const { transcript, keepFromIndex } = await import('../src/agent/compact.js');
    const msgs = [{ role: 'user', content: 'objetivo inicial' }];
    for (let i = 0; i < 50; i++) msgs.push({ role: 'assistant', content: `paso ${i} ${'x'.repeat(400)}` }, { role: 'user', content: `pedido ${i}` });
    const full = transcript(msgs);
    const small = transcript(msgs, 1000);
    assert(full.length > small.length * 3, 'recorta');
    assert(small.startsWith('[user]\nobjetivo inicial') && small.includes('pedido 49') && /older messages omitted/.test(small), 'conserva el inicio y lo reciente');
    assert(keepFromIndex(msgs) === msgs.length - 1, 'último pedido');
  });

  await t('web: motores en orden, filtros por dominio y búsqueda con SearXNG propio', async (assert) => {
    const W = await import('../src/tools/web.js');
    const http = await import('node:http');
    assert(W.searchEngines({}).map((e) => e.name).join() === 'duckduckgo,bing', 'sin claves: DuckDuckGo y Bing');
    assert(W.searchEngines({ webSearch: { braveKey: 'k', searxngUrl: 'http://s' } }).map((e) => e.name).join() === 'brave,searxng,duckduckgo,bing', 'con claves primero');
    assert(W.searchEngines({ webSearch: { engine: 'bing' } }).map((e) => e.name).join() === 'bing', 'motor fijo');
    const res = [{ url: 'https://docs.python.org/a' }, { url: 'https://www.pinterest.com/x' }, { url: 'https://docs.python.org/a' }, { url: 'https://nodejs.org/b' }];
    assert(W.filterResults(res, { blocked: ['pinterest.com'] }).length === 2, 'bloquea dominios y quita duplicados');
    assert(W.filterResults(res, { allowed: ['python.org'] }).map((r) => r.url).join() === 'https://docs.python.org/a', 'permite subdominios');
    assert(W.htmlToText('it&#x27;s &amp; &#233;') === "it's & é", 'entidades HTML');
    let seenQ = '';
    const srv = http.createServer((req, res2) => {
      seenQ = new URL(req.url, 'http://x').searchParams.get('q');
      res2.writeHead(200, { 'Content-Type': 'application/json' });
      res2.end(JSON.stringify({ results: [{ title: 'Node 22', url: 'https://nodejs.org/en/blog/22', content: 'Release notes' }, { title: 'Spam', url: 'https://spam.example/x', content: '' }] }));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const settings = { webSearch: { searxngUrl: `http://127.0.0.1:${srv.address().port}`, engine: 'searxng' } };
      const r = await W.WebSearch.run({ query: 'node 22', blocked_domains: ['spam.example'] }, { runtime: { settings } });
      assert(r.content.includes('https://nodejs.org/en/blog/22') && !r.content.includes('spam.example') && r.content.includes('engine: searxng'), `resultados: ${r.content}`);
      await W.WebSearch.run({ query: 'fetch', allowed_domains: ['nodejs.org'] }, { runtime: { settings } });
      assert(seenQ === 'fetch site:nodejs.org', `un dominio permitido se pasa al buscador: ${seenQ}`);
    } finally { srv.close(); }
  });

  await t('usage: costo estimado, histórico, límites y uso desde la cola', async (assert) => {
    const U = await import('../src/usage.js');
    const cost = U.estimateCost({ m1: { input: 3, output: 15, cached: 0.3 } }, 'p', 'm1', { input: 1e6, cached: 5e5, output: 1e5 });
    assert(Math.abs(cost - (1.5 + 0.15 + 1.5)) < 1e-9, `costo: ${cost}`);
    assert(U.estimateCost({}, 'p', 'x', { input: 1 }) === null, 'sin precio');
    U.recordUsage({ provider: 'p', model: 'm1', usage: { input: 10, output: 2, cached: 1 }, cost: 0.5, kind: 'nube' });
    U.recordUsage({ provider: 'p', model: 'm1', usage: { input: 5, output: 1 }, kind: 'nube' });
    const today = U.usageTotals('today')['p:m1'];
    assert(today && today.requests === 2 && today.input === 15 && today.output === 3 && today.cost === 0.5, `histórico: ${JSON.stringify(today)}`);
    assert(U.usageTotals('month')['p:m1']?.requests >= 2, 'mes');
    const rl = U.parseRateLimits(new Headers({ 'anthropic-ratelimit-tokens-remaining': '9000', 'anthropic-ratelimit-tokens-limit': '10000', 'x-ratelimit-remaining-requests': '49' }));
    assert(rl?.tokens.remaining === 9000 && rl.tokens.limit === 10000 && rl.requests.remaining === 49, 'límites');
    assert(U.parseRateLimits(new Headers()) === null, 'sin límites');
    const sse = ['data: {"choices":[]}', '', 'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}', '', 'data: [DONE]', ''].join('\n');
    assert(JSON.stringify(U.usageFromTail(sse)) === '{"input":7,"output":3}', 'SSE');
    const nd = ['{"done":false}', '{"done":true,"prompt_eval_count":4,"eval_count":2}', ''].join('\n');
    assert(JSON.stringify(U.usageFromTail(nd)) === '{"input":4,"output":2}', 'NDJSON');
  });
}
