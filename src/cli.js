// Punto de entrada: opciones de línea de comandos y subcomandos.
import fs from 'node:fs';
import { VERSION, APP_NAME } from './config.js';
import { c } from './ui/theme.js';
import { setLanguage, L } from './i18n.js';
import { loadSettings, findProjectRoot } from './config.js';

const HELP = `${APP_NAME} ${VERSION} — agente de programación open source para modelos locales, en la nube o en tu PC remota

Uso:
  codice [tarea]                     Consola interactiva (opcionalmente con una tarea inicial)
  codice -p "tarea"                  Ejecuta una tarea y termina (admite entrada por tubería)

Opciones:
  -m, --model <modelo>               Modelo (acepta proveedor:modelo)
      --provider <nombre>            Proveedor: ollama, lmstudio, llamacpp, vllm, jan, openrouter, openai…
      --base-url <url>               Servidor compatible con OpenAI (o --provider-type ollama|codice)
      --api-key <clave>              API key para --base-url
  -c, --continue                     Retoma la última conversación de este directorio
  -r, --resume <id>                  Retoma una conversación concreta
      --permission-mode <modo>       default | acceptEdits | plan | bypass
      --yolo                         Sin pedir permisos (equivale a bypass)
      --tool-mode <modo>             auto | native | prompt
      --offline                      Desactiva las herramientas de red
      --output-format <fmt>          text | json (con -p)
      --theme <tema>                 auto | brasa | alba | medianoche | daltonico | alto-contraste | fosforo
      --screen-reader                Salida apta para lectores de pantalla
      --reduce-motion                Sin animaciones
      --no-color                     Sin colores (también respeta NO_COLOR)
      --no-mcp                       No conectar servidores MCP
      --cwd <ruta>                   Directorio de trabajo
  -v, --version                      Versión
  -h, --help                         Esta ayuda

Subcomandos:
  codice models                      Lista los modelos del proveedor
  codice doctor                      Diagnóstico de instalación y conexión
  codice mcp list|add|remove         Gestiona servidores MCP
  codice plugin install|list|remove  Gestiona plugins
  codice agents                      Lista los agentes
  codice config get|set <clave> [valor]
  codice serve                       Comparte los modelos de esta PC con otras máquinas
  codice connect <url> --token <t>   Usa los modelos de una PC con "codice serve"
  codice bench                       Mide velocidad y soporte de herramientas de tus modelos
`;

const HELP_EN = `${APP_NAME} ${VERSION} — open-source coding agent for local, cloud or your own remote models

Usage:
  codice [task]                      Interactive console (optionally with an initial task)
  codice -p "task"                   Run one task and exit (accepts piped input)

Options:
  -m, --model <model>                Model (accepts provider:model)
      --provider <name>              Provider: ollama, lmstudio, llamacpp, vllm, jan, openrouter, openai…
      --base-url <url>               OpenAI-compatible server (or --provider-type ollama|codice)
      --api-key <key>                API key for --base-url
  -c, --continue                     Resume the last conversation in this folder
  -r, --resume <id>                  Resume a specific conversation
      --permission-mode <mode>       default | acceptEdits | plan | bypass
      --yolo                         Never ask for permission (same as bypass)
      --tool-mode <mode>             auto | native | prompt
      --offline                      Disable network tools
      --output-format <fmt>          text | json (with -p)
      --theme <theme>                auto | brasa | alba | medianoche | daltonico | alto-contraste | fosforo
      --screen-reader                Screen-reader friendly output
      --reduce-motion                No animations
      --no-color                     No colors (NO_COLOR is also respected)
      --no-mcp                       Do not connect MCP servers
      --cwd <path>                   Working directory
  -v, --version                      Version
  -h, --help                         This help

Subcommands:
  codice models                      List the provider models
  codice doctor                      Check installation and connection
  codice mcp list|add|remove         Manage MCP servers
  codice plugin install|list|remove  Manage plugins
  codice agents                      List agents
  codice config get|set <key> [value]
  codice serve                       Share this PC's models with other machines
  codice connect <url> --token <t>   Use the models of a PC running "codice serve"
  codice bench                       Measure speed and tool support of your models
`;

export function parseArgs(argv) {
  const o = { _: [] };
  const takes = new Set(['model', 'provider', 'base-url', 'api-key', 'resume', 'permission-mode', 'tool-mode', 'output-format', 'theme', 'cwd', 'provider-type', 'token', 'name', 'port', 'host', 'backend', 'backend-url', 'cert', 'key', 'models']);
  const short = { m: 'model', c: 'continue', r: 'resume', p: 'print', v: 'version', h: 'help' };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '--') { o._.push(...argv.slice(i + 1)); break; }
    if (/^-[a-z]$/.test(a)) a = `--${short[a[1]] || a[1]}`;
    if (a.startsWith('--')) {
      let [k, v] = a.slice(2).split(/=(.*)/s);
      if (k === 'dangerously-skip-permissions') k = 'yolo';
      if (v === undefined && takes.has(k)) {
        if (k === 'resume' && (argv[i + 1] === undefined || argv[i + 1].startsWith('-'))) v = true;
        else v = argv[++i];
      }
      if (v === undefined) v = true;
      o[k] = v;
    } else o._.push(a);
  }
  return o;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const ch of process.stdin) chunks.push(ch);
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(argv) {
  const o = parseArgs(argv);
  if (o.version) { console.log(`codice ${VERSION}`); return; }
  if (o.help) {
    try { setLanguage(loadSettings(findProjectRoot(process.cwd())).language); } catch { /* idioma por defecto */ }
    console.log(L(HELP, HELP_EN));
    return;
  }
  if (o.cwd) process.chdir(o.cwd);

  const sub = o._[0];
  const subcommands = ['models', 'doctor', 'mcp', 'plugin', 'plugins', 'agents', 'config', 'serve', 'connect', 'bench'];
  if (subcommands.includes(sub)) {
    const { runSubcommand } = await import('./subcommands.js');
    process.exitCode = await runSubcommand(sub, o._.slice(1), o);
    return;
  }

  const { Runtime } = await import('./runtime.js');
  const { Session } = await import('./session.js');
  const runtime = new Runtime({
    cwd: process.cwd(),
    overrides: {
      model: o.model, provider: o.provider, baseUrl: o['base-url'], apiKey: o['api-key'], providerType: o['provider-type'],
      permissionMode: o.yolo ? 'bypass' : o['permission-mode'], toolMode: o['tool-mode'], offline: o.offline,
      screenReader: o['screen-reader'], reduceMotion: o['reduce-motion'], noColor: o['no-color'], theme: o.theme,
    },
  });

  let session = null;
  if (o.continue) session = Session.latest(runtime.cwd);
  else if (typeof o.resume === 'string') session = Session.load(o.resume);
  if ((o.continue || o.resume) && !session && o.resume !== true) console.error(c.warning(L('No encontré una conversación para retomar; empiezo una nueva.', 'No conversation to resume; starting a new one.')));
  session ||= new Session({ cwd: runtime.cwd });

  if (o.mcp !== false && !o['no-mcp']) await runtime.startMcp();

  if (o.print) {
    const stdin = await readStdin();
    const task = [typeof o.print === 'string' ? o.print : o._.join(' '), stdin.trim() ? `\n\n<stdin>\n${stdin}\n</stdin>` : ''].join('').trim();
    if (!task) { console.error(L('Indica una tarea: codice -p "…"', 'Provide a task: codice -p "…"')); process.exitCode = 2; return; }
    const { runPrint } = await import('./print.js');
    process.exitCode = await runPrint(runtime, task, { session, outputFormat: o['output-format'] });
    return;
  }

  if (o.resume === true) {
    // --resume sin id: se elige en la consola
    const { startRepl } = await import('./repl.js');
    return startRepl(runtime, { session, initialPrompt: '/resume' });
  }
  const { startRepl } = await import('./repl.js');
  await startRepl(runtime, { session, initialPrompt: o._.join(' ') || null });
}

export function fileExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}
