// Comandos "/" integrados. Los nombres son iguales en todos los idiomas; los textos usan L(es, en).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { c, style } from '../ui/theme.js';
import * as ui from '../ui/output.js';
import { select, confirm } from '../ui/select.js';
import { listProviderNames, resolveProvider, VERSION, HOME, APP_NAME } from '../config.js';
import { MODES, MODE_INFO } from '../permissions.js';
import { installPlugin, removePlugin, listPlugins } from '../plugins.js';
import { saveAgent } from '../resources.js';
import { addMemory, memoryFiles } from '../memory.js';
import { Session } from '../session.js';
import { detectShell, shellLabel } from '../tools/bash.js';
import { formatTokens, formatDuration, relPath } from '../util/fs.js';
import { stripThinking } from '../llm/stream.js';
import { L } from '../i18n.js';
import { customizeCommands } from './customize.js';

const fmtSize = (b) => (b ? `${(b / 1e9).toFixed(1)} GB` : '');

function openInEditor(file) {
  const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'nano');
  spawn(editor, [file], { stdio: 'inherit', shell: process.platform === 'win32', detached: process.platform === 'win32' });
}

export const BUILTIN_COMMANDS = {
  help: {
    get description() { return L('Muestra los comandos y atajos', 'Show commands and shortcuts'); },
    async run(args, { runtime, repl }) {
      ui.println(c.accent(L('Comandos', 'Commands'), { bold: true }));
      for (const cmd of repl.commandList()) ui.println(`  ${c.accent(cmd.name.padEnd(22))}${c.muted(cmd.description)}${cmd.source !== 'integrado' ? c.dim(`  · ${cmd.label || cmd.source}`) : ''}`);
      ui.println('');
      ui.println(c.accent(L('Atajos', 'Shortcuts'), { bold: true }));
      const keys = [
        ['!cmd', L('ejecuta en el shell y añade la salida al contexto', 'run in the shell and add the output to the context')],
        ['#texto', L('guarda una nota en CODICE.md', 'save a note to CODICE.md')],
        ['@ruta', L('adjunta un archivo o carpeta', 'attach a file or folder')],
        ['\\ + enter', L('nueva línea', 'new line')],
        ['shift+tab', L('cambia el modo de permisos', 'cycle permission mode')],
        ['esc', L('interrumpe al agente', 'interrupt the agent')],
        ['ctrl+o', L('muestra la salida completa de la última herramienta', 'show the full output of the last tool')],
        ['ctrl+c ×2', L('salir', 'exit')],
      ];
      for (const [k, d] of keys) ui.println(`  ${c.accent(k.padEnd(22))}${c.muted(d)}`);
    },
  },

  setup: {
    get description() { return L('Configuración inicial: idioma, tema y cómo usar modelos', 'Initial setup: language, theme and how to run models'); },
    async run(args, { runtime, repl }) {
      const { runOnboarding } = await import('../onboarding.js');
      await runOnboarding(runtime, repl.input);
      ui.banner({ version: VERSION, model: runtime.settings.model, provider: runtime.providerInfo()?.label || runtime.settings.provider, cwd: runtime.cwd, memory: runtime.memory.map((m) => m.name), mascot: runtime.mascot() });
    },
  },

  exit: { get description() { return L('Salir de Códice', 'Exit Códice'); }, aliases: ['quit', 'salir'], async run(a, { repl }) { await repl.exit(); } },

  clear: {
    get description() { return L('Empieza una conversación nueva', 'Start a new conversation'); },
    aliases: ['new', 'reset'],
    async run(a, { repl }) { repl.newSession(); ui.success(L('Conversación nueva.', 'New conversation.')); },
  },

  model: {
    get description() { return L('Cambia el modelo (sin argumentos: elegir de la lista)', 'Change the model (no arguments: pick from a list)'); },
    argumentHint: '[provider:]model',
    async run(args, ctx) {
      const { runtime } = ctx;
      if (!args) return BUILTIN_COMMANDS.models.run('', ctx);
      let provider = runtime.settings.provider, model = args.trim();
      const i = model.indexOf(':');
      if (i > 0 && listProviderNames(runtime.settings).includes(model.slice(0, i))) { provider = model.slice(0, i); model = model.slice(i + 1); }
      runtime.save('provider', provider);
      runtime.save('model', model);
      ui.success(`${L('Modelo', 'Model')}: ${c.soft(model, { bold: true })} ${c.muted(`(${provider})`)}`);
    },
  },

  models: {
    get description() { return L('Elige modelo: locales (GGUF/Ollama), descargar de Hugging Face o del proveedor actual', 'Pick a model: local (GGUF/Ollama), download from Hugging Face or from the current provider'); },
    argumentHint: '[add-dir <path> | dirs | download <user/repo>]',
    async run(args, { runtime, repl }) {
      if (runtime.providerInfo()?.type === 'local' || /^(add-dir|remove-dir|dirs|download)\b/.test(args.trim())) {
        const { localModelsCommand } = await import('./localModels.js');
        return localModelsCommand(args, { runtime, repl });
      }
      const client = runtime.createClient({ model: runtime.settings.model || 'x' });
      let models;
      runtime.spinner.start(L('Consultando modelos…', 'Fetching models…'));
      try { models = await client.listModels(); } catch (e) { runtime.spinner.stop(); return repl.showError(e); }
      runtime.spinner.stop();
      if (!models.length) return ui.warn(L(`${runtime.settings.provider} no tiene modelos.`, `${runtime.settings.provider} has no models.`) + (runtime.settings.provider === 'ollama' ? ` ${L('Descarga uno con: ollama pull qwen2.5-coder:3b', 'Download one with: ollama pull qwen2.5-coder:3b')}` : ''));
      const current = runtime.settings.model;
      const options = models.map((m) => {
        const mode = runtime.toolModes[m.id] || '';
        return { label: m.id, value: m.id, hint: [fmtSize(m.size), m.id === current ? L('actual', 'current') : '', mode === 'prompt' ? L('◇ modo prompt', '◇ prompt mode') : ''].filter(Boolean).join(' · '), hintColor: m.id === current ? 'status/success' : 'text/dim' };
      });
      const choice = await select(repl.input, { title: `${L('Modelos en', 'Models on')} ${c.primary(runtime.providerInfo()?.label || runtime.settings.provider, { bold: true })}`, options, initial: Math.max(0, models.findIndex((m) => m.id === current)) });
      if (!choice) return;
      runtime.save('model', choice);
      ui.success(`${L('Modelo', 'Model')}: ${c.soft(choice, { bold: true })}`);
    },
  },

  provider: {
    get description() { return L('Cambia de proveedor (local, nube o PC remota) o añade uno', 'Switch provider (local, cloud or remote PC) or add one'); },
    argumentHint: '[name] | add <name> <url> [ollama|openai|codice] [API_KEY_ENV]',
    async run(args, { runtime, repl }) {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (sub === 'add') {
        const [name, url, type = 'openai', keyEnv] = rest;
        if (!name || !url) return ui.warn(L('Uso: /provider add <nombre> <url> [ollama|openai|codice] [VARIABLE_API_KEY]', 'Usage: /provider add <name> <url> [ollama|openai|codice] [API_KEY_ENV]'));
        runtime.save(`providers.${name}`, { type, baseUrl: url, ...(keyEnv ? { apiKeyEnv: keyEnv } : {}) });
        return ui.success(L(`Proveedor ${name} añadido. Actívalo con /provider ${name}`, `Provider ${name} added. Activate it with /provider ${name}`));
      }
      if (sub === 'remove') {
        runtime.save(`providers.${rest[0]}`, undefined);
        return ui.success(L(`Proveedor ${rest[0]} eliminado.`, `Provider ${rest[0]} removed.`));
      }
      let name = sub;
      if (!name) {
        const options = listProviderNames(runtime.settings).map((n) => {
          const p = resolveProvider(runtime.settings, n);
          const kind = p.type === 'codice' ? L('PC remota', 'remote PC') : p.cloud ? L('nube', 'cloud') : 'local';
          const noKey = p.cloud && !p.apiKey ? L(' · sin API key', ' · no API key') : '';
          return { label: `${(p.label || n).padEnd(16)} ${c.dim(p.baseUrl)}`, value: n, hint: `${kind}${noKey}${n === runtime.settings.provider ? ` · ${L('actual', 'current')}` : ''}`, hintColor: n === runtime.settings.provider ? 'status/success' : 'text/dim' };
        });
        name = await select(repl.input, { title: L('Proveedor', 'Provider'), options, initial: Math.max(0, options.findIndex((o) => o.value === runtime.settings.provider)) });
        if (!name) return;
      }
      const p = resolveProvider(runtime.settings, name);
      if (!p) return ui.warn(L(`No conozco el proveedor "${name}". Añádelo con /provider add.`, `Unknown provider "${name}". Add it with /provider add.`));
      if (p.cloud && !p.apiKey) return ui.warn(L(`${p.label || name} necesita una API key. Configúrala con /setup.`, `${p.label || name} needs an API key. Set it up with /setup.`));
      runtime.save('provider', name);
      ui.success(`${L('Proveedor', 'Provider')}: ${p.label || name}`);
      await BUILTIN_COMMANDS.models.run('', { runtime, repl });
    },
  },

  mode: {
    get description() { return L('Modo de permisos: default, acceptEdits, plan o bypass', 'Permission mode: default, acceptEdits, plan or bypass'); },
    argumentHint: '[mode]',
    async run(args, { runtime, repl }) {
      let m = args.trim();
      if (!m) {
        m = await select(repl.input, { title: L('Modo de permisos', 'Permission mode'), options: MODES.map((x) => ({ label: MODE_INFO[x].label, value: x, hint: MODE_INFO[x].hint })), initial: MODES.indexOf(runtime.permissionMode) });
        if (!m) return;
      }
      if (!MODES.includes(m)) return ui.warn(`${L('Modos válidos', 'Valid modes')}: ${MODES.join(', ')}`);
      runtime.setPermissionMode(m);
      ui.success(`${MODE_INFO[m].label} — ${MODE_INFO[m].hint}`);
    },
  },

  permissions: {
    get description() { return L('Ver o editar reglas de permisos', 'View or edit permission rules'); },
    argumentHint: '[allow|deny|remove] <rule>',
    async run(args, { runtime }) {
      const [sub, ...rest] = args.trim().split(/\s+/);
      const rule = rest.join(' ');
      const p = runtime.settings.permissions;
      if ((sub === 'allow' || sub === 'deny') && rule) {
        runtime.save(`permissions.${sub}`, [...new Set([...(runtime.localSettings.permissions?.[sub] || []), rule])], 'local');
        return ui.success(`${sub}: ${rule}`);
      }
      if (sub === 'remove' && rule) {
        for (const k of ['allow', 'deny']) runtime.save(`permissions.${k}`, (runtime.localSettings.permissions?.[k] || []).filter((r) => r !== rule), 'local');
        runtime.permissions.sessionAllow = runtime.permissions.sessionAllow.filter((r) => r !== rule);
        return ui.success(L(`Regla eliminada: ${rule}`, `Rule removed: ${rule}`));
      }
      ui.println(MODE_INFO[runtime.permissionMode].label);
      ui.println(c.success(L('Permitidas', 'Allowed'), { bold: true }));
      for (const r of [...p.allow, ...runtime.permissions.sessionAllow]) ui.println(`  ${c.success('✓')} ${r}`);
      ui.println(c.error(L('Bloqueadas', 'Denied'), { bold: true }));
      for (const r of p.deny) ui.println(`  ${c.error('✗')} ${r}`);
      ui.hint(L('Ejemplos: /permissions allow Bash(npm test:*) · /permissions deny Bash(rm -rf:*)', 'Examples: /permissions allow Bash(npm test:*) · /permissions deny Bash(rm -rf:*)'));
    },
  },

  tools: {
    get description() { return L('Lista las herramientas disponibles', 'List available tools'); },
    async run(a, { repl }) {
      for (const t of repl.agent.tools()) {
        const tag = t.mcp ? c.info('MCP') : t.readOnly ? c.dim(L('lectura', 'read')) : t.edits ? c.warning(L('edición', 'edit')) : c.warning(L('acción', 'action'));
        ui.println(`  ${style(t.name.padEnd(28), { bold: true, fg: 'text/primary' })}${tag}  ${c.muted(String(t.description).split('\n')[0].slice(0, 80))}`);
      }
    },
  },

  mcp: {
    get description() { return L('Servidores MCP: estado, add, remove, restart', 'MCP servers: status, add, remove, restart'); },
    argumentHint: '[add <name> <command…> | add <name> --url <url> | remove <name> | restart]',
    async run(args, { runtime }) {
      const [sub, name, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (sub === 'add') {
        if (!name || !rest.length) return ui.warn(L('Uso: /mcp add <nombre> <comando> [args…]  o  /mcp add <nombre> --url https://…', 'Usage: /mcp add <name> <command> [args…]  or  /mcp add <name> --url https://…'));
        const cfg = rest[0] === '--url' ? { type: 'http', url: rest[1] } : { command: rest[0], args: rest.slice(1) };
        runtime.save(`mcpServers.${name}`, cfg);
        runtime.spinner.start(L(`Conectando ${name}…`, `Connecting ${name}…`));
        const cl = await runtime.mcp.restart(name, cfg);
        runtime.spinner.stop();
        return cl.status === 'conectado' ? ui.success(L(`MCP ${name} conectado · ${cl.tools.length} herramientas`, `MCP ${name} connected · ${cl.tools.length} tools`)) : ui.errorBox(L(`No se pudo conectar ${name}`, `Could not connect ${name}`), cl.error, L('Revisa el comando o la URL.', 'Check the command or URL.'));
      }
      if (sub === 'remove') {
        runtime.save(`mcpServers.${name}`, undefined);
        runtime.mcp.clients.get(name)?.close();
        runtime.mcp.clients.delete(name);
        return ui.success(L(`MCP ${name} eliminado.`, `MCP ${name} removed.`));
      }
      if (sub === 'restart') {
        runtime.mcp.stopAll();
        runtime.spinner.start(L('Reconectando servidores MCP…', 'Reconnecting MCP servers…'));
        await runtime.startMcp();
        runtime.spinner.stop();
      }
      const st = runtime.mcp.status();
      if (!st.length) return ui.hint(L('No hay servidores MCP. Ejemplo: /mcp add filesystem npx -y @modelcontextprotocol/server-filesystem .', 'No MCP servers. Example: /mcp add filesystem npx -y @modelcontextprotocol/server-filesystem .'));
      for (const s of st) {
        const icon = s.status === 'conectado' ? c.info('◆') : c.error('✗');
        ui.println(`  ${icon} ${style(s.name, { bold: true, fg: 'text/primary' })}  ${s.status === 'conectado' ? c.muted(`${s.tools} ${L('herramientas', 'tools')}${s.server ? ` · ${s.server}` : ''}`) : c.error(s.error || s.status)}`);
      }
    },
  },

  plugin: {
    get description() { return L('Plugins: install, remove, enable, disable, list', 'Plugins: install, remove, enable, disable, list'); },
    aliases: ['plugins'],
    argumentHint: '[install <path|git|user/repo|plugin@marketplace> | remove | enable | disable <name>]',
    async run(args, { runtime }) {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const target = rest.join(' ');
      try {
        if (sub === 'install' && target) {
          runtime.spinner.start(L('Instalando plugin…', 'Installing plugin…'));
          const p = installPlugin(target);
          runtime.spinner.stop();
          runtime.save(`enabledPlugins.${p.name}`, true);
          await runtime.startMcp();
          return ui.success(L(`Plugin ${p.name}${p.version ? ` v${p.version}` : ''} instalado.`, `Plugin ${p.name}${p.version ? ` v${p.version}` : ''} installed.`));
        }
        if (sub === 'remove' && target) { removePlugin(target); runtime.save(`enabledPlugins.${target}`, undefined); return ui.success(L(`Plugin ${target} eliminado.`, `Plugin ${target} removed.`)); }
        if ((sub === 'enable' || sub === 'disable') && target) { runtime.save(`enabledPlugins.${target}`, sub === 'enable'); return ui.success(`${target}: ${sub === 'enable' ? L('activado', 'enabled') : L('desactivado', 'disabled')}`); }
      } catch (e) {
        runtime.spinner.stop();
        return ui.errorBox(L('No se pudo completar la operación', 'The operation failed'), e.message);
      }
      const all = listPlugins(runtime.settings);
      if (!all.length) return ui.hint(L('No hay plugins. Prueba: /plugin install <ruta o repositorio>', 'No plugins. Try: /plugin install <path or repository>'));
      for (const p of all) ui.println(`  ${p.enabled ? c.success('●') : c.dim('○')} ${style(p.name, { bold: true, fg: 'text/primary' })} ${c.dim(p.version)}  ${c.muted(p.description)}`);
    },
  },

  skills: {
    get description() { return L('Lista las skills instaladas', 'List installed skills'); },
    async run(a, { runtime }) {
      const list = Object.values(runtime.skills);
      if (!list.length) return ui.hint(L(`No hay skills. Crea una en ${path.join(HOME, 'skills', '<nombre>', 'SKILL.md')} o en .codice/skills/`, `No skills. Create one in ${path.join(HOME, 'skills', '<name>', 'SKILL.md')} or .codice/skills/`));
      for (const s of list) ui.println(`  ${c.agent(s.name.padEnd(28), { bold: true })}${c.muted(s.description.slice(0, 90))} ${c.dim(`· ${s.source}`)}`);
    },
  },

  agents: {
    get description() { return L('Agentes y subagentes: ver, crear, editar, borrar, asignar modelo', 'Agents and subagents: view, create, edit, delete, assign model'); },
    argumentHint: '[new]',
    async run(args, ctx) {
      const { runtime, repl } = ctx;
      if (args.trim() === 'new' || args.trim() === 'nuevo') return createAgentWizard(ctx);
      const list = Object.values(runtime.agents);
      const options = [{ label: c.accent(L('+ Crear un agente nuevo', '+ Create a new agent')), value: '__new__' }, ...list.map((a) => ({ label: a.name, value: a.name, hint: `${a.source}${runtime.settings.agentModels?.[a.name] || a.model ? ` · ${runtime.settings.agentModels?.[a.name] || a.model}` : ''}` }))];
      const pick = await select(repl.input, { title: L('Agentes', 'Agents'), options });
      if (!pick) return;
      if (pick === '__new__') return createAgentWizard(ctx);
      const a = runtime.agents[pick];
      ui.box([
        `${c.agent(a.name, { bold: true })} ${c.dim(`· ${a.source}`)}`,
        c.muted(a.description),
        `${c.dim(L('herramientas ', 'tools        '))}${a.tools?.join(', ') || L('todas', 'all')}`,
        `${c.dim(L('modelo       ', 'model        '))}${runtime.settings.agentModels?.[a.name] || a.model || L('el de la sesión', 'session model')}`,
        `${c.dim(L('archivo      ', 'file         '))}${c.info(a.file)}`,
      ]);
      const editable = a.source !== 'incluido' && !a.source.startsWith('plugin');
      const action = await select(repl.input, {
        title: L('¿Qué quieres hacer?', 'What do you want to do?'),
        options: [
          { label: L('Asignar un modelo a este agente', 'Assign a model to this agent'), value: 'model' },
          { label: editable ? L('Editar el archivo', 'Edit the file') : L('Copiar a mis agentes para personalizarlo', 'Copy to my agents to customize it'), value: 'edit' },
          ...(editable ? [{ label: L('Borrar', 'Delete'), value: 'delete' }] : []),
          { label: L('Volver', 'Back'), value: null },
        ],
      });
      if (action === 'model') {
        const m = await repl.input.question(`${c.accent('›')} ${L(`Modelo para ${a.name} (proveedor:modelo, vacío = el de la sesión)`, `Model for ${a.name} (provider:model, empty = session model)`)}: `);
        runtime.save(`agentModels.${a.name}`, m?.trim() || undefined);
        ui.success(m?.trim() ? L(`${a.name} usará ${m.trim()}`, `${a.name} will use ${m.trim()}`) : L(`${a.name} usará el modelo de la sesión`, `${a.name} will use the session model`));
      } else if (action === 'edit') {
        let file = a.file;
        if (!editable) { file = saveAgent('usuario', runtime.projectRoot, { ...a, name: a.name.split(':').pop() }); runtime.reload(); ui.success(`${L('Copiado a', 'Copied to')} ${file}`); }
        openInEditor(file);
      } else if (action === 'delete') {
        if (await confirm(repl.input, L(`¿Borrar el agente ${a.name}?`, `Delete agent ${a.name}?`))) { fs.unlinkSync(a.file); runtime.reload(); ui.success(L('Agente borrado.', 'Agent deleted.')); }
      }
    },
  },

  commands: {
    get description() { return L('Lista los comandos personalizados', 'List custom commands'); },
    async run(a, { runtime }) {
      const list = Object.values(runtime.commands);
      if (!list.length) return ui.hint(L('No hay comandos personalizados. Crea un .md en ~/.codice/commands/ o .codice/commands/ (usa $ARGUMENTS).', 'No custom commands. Create a .md in ~/.codice/commands/ or .codice/commands/ (use $ARGUMENTS).'));
      for (const cmd of list) ui.println(`  ${c.accent(`/${cmd.name}`.padEnd(26))}${c.muted(cmd.description)} ${c.dim(`· ${cmd.source}`)}`);
    },
  },

  memory: {
    get description() { return L('Memoria del proyecto (CODICE.md): ver, add, edit', 'Project memory (CODICE.md): view, add, edit'); },
    argumentHint: '[add <text> | edit | clear-activity]',
    async run(args, { runtime }) {
      const [sub, ...rest] = args.trim().split(/\s+/);
      const { readActivity, clearActivity } = await import('../activity.js');
      if (sub === 'add' && rest.length) { const f = addMemory(runtime.projectRoot, rest.join(' ')); runtime.reload(); return ui.success(`${L('Guardado en', 'Saved to')} ${relPath(f, runtime.cwd)}`); }
      if (sub === 'edit') {
        const f = path.join(runtime.projectRoot, 'CODICE.md');
        if (!fs.existsSync(f)) fs.writeFileSync(f, `# ${L('Memoria del proyecto', 'Project memory')}\n\n`);
        return openInEditor(f);
      }
      if (sub === 'clear-activity') { clearActivity(runtime.projectRoot); runtime.recentActivity = []; return ui.success(L('Actividad reciente borrada.', 'Recent activity cleared.')); }
      const files = memoryFiles(runtime.cwd, runtime.projectRoot, { compat: runtime.settings.compat?.claude !== false });
      ui.println(c.accent(L('Archivos de contexto', 'Context files'), { bold: true }));
      if (!files.length) ui.hint(L('  Ninguno todavía. Usa /init para crear CODICE.md o escribe "# nota".', '  None yet. Use /init to create CODICE.md or type "# note".'));
      for (const f of files) ui.println(`  ${c.success('●')} ${c.info(f.file)} ${c.dim(`· ${f.agent} · ${f.scope === 'usuario' ? L('usuario', 'user') : L('proyecto', 'project')}`)}`);
      const act = readActivity(runtime.projectRoot, { limit: 8 });
      ui.println(c.accent(L('Actividad reciente (memoria entre sesiones)', 'Recent activity (cross-session memory)'), { bold: true }));
      if (!act.length) ui.hint(L('  Todavía no hay actividad registrada en este proyecto.', '  No activity recorded in this project yet.'));
      for (const e of act) ui.println(`  ${c.dim(new Date(e.time).toLocaleString())}  ${c.primary(e.prompt)}${e.files?.length ? c.muted(`  · ${e.files.slice(0, 3).join(', ')}`) : ''}${e.error ? c.error('  · error') : ''}`);
      ui.hint(L('Códice también lee los archivos de contexto de Claude Code, Codex, Gemini, Qwen, Copilot, Cursor, Windsurf, Cline y Aider. /memory clear-activity borra la actividad.', 'Códice also reads the context files of Claude Code, Codex, Gemini, Qwen, Copilot, Cursor, Windsurf, Cline and Aider. /memory clear-activity clears the activity.'));
    },
  },

  init: {
    get description() { return L('Analiza el proyecto y crea CODICE.md', 'Analyze the project and create CODICE.md'); },
    async run(args, { repl }) {
      await repl.runPrompt(`Analyze this codebase and create (or improve, if it exists) a CODICE.md file at the project root to guide future work. Include: what the project is, how to install/build/test/lint (exact commands), the architecture and key directories, and code conventions. If context files from other agents exist (CLAUDE.md, AGENTS.md, GEMINI.md, QWEN.md, .github/copilot-instructions.md, .cursorrules, .cursor/rules, .windsurfrules, .clinerules, CONVENTIONS.md), read them and incorporate what is still accurate; do not delete them. Keep it concise and factual; do not invent anything. Write it in ${L('Spanish', 'English')}. ${args}`.trim(), { display: '/init' });
    },
  },

  compact: {
    get description() { return L('Resume la conversación para liberar contexto', 'Summarize the conversation to free context'); },
    argumentHint: '[instructions]',
    async run(args, { repl }) {
      const before = repl.agent.contextUsage().used;
      try {
        const s = await repl.agent.compact({ instructions: args });
        if (!s) return ui.hint(L('No hay suficiente conversación para compactar.', 'Not enough conversation to compact.'));
        ui.success(`${L('Conversación compactada', 'Conversation compacted')}: ${formatTokens(before)} → ${formatTokens(repl.agent.contextUsage().used)} tokens.`);
        repl.session.save();
      } catch (e) { repl.showError(e); }
    },
  },

  context: {
    get description() { return L('Uso estimado del contexto', 'Estimated context usage'); },
    async run(a, { repl }) {
      const u = repl.agent.contextUsage();
      const pct = Math.min(100, Math.round((u.used / u.max) * 100));
      const filled = Math.round((pct / 100) * 30);
      ui.println(`${c.accent('█'.repeat(filled))}${c.border('░'.repeat(30 - filled))} ${c.primary(`${pct} %`, { bold: true })}  ${c.muted(`${formatTokens(u.used)} / ${formatTokens(u.max)} tokens`)}`);
      if (pct > 70) ui.hint(L('Usa /compact para resumir la conversación.', 'Use /compact to summarize the conversation.'));
    },
  },

  cost: {
    get description() { return L('Tokens usados, velocidad y costo', 'Tokens used, speed and cost'); },
    aliases: ['usage', 'stats'],
    async run(a, { runtime }) {
      const u = runtime.usage;
      ui.println(`${c.primary(L('Sesión', 'Session'), { bold: true })}  ${c.muted(`${u.requests} ${L('peticiones', 'requests')} · ${L('entrada', 'input')} ${formatTokens(u.input)} · ${L('salida', 'output')} ${formatTokens(u.output)} · ${formatDuration(u.ms)}`)}`);
      for (const [model, m] of Object.entries(u.byModel)) {
        const tps = m.ms ? (m.output / (m.ms / 1000)).toFixed(1) : '?';
        ui.println(`  ${c.soft(model.padEnd(36))}${c.muted(`${formatTokens(m.input + m.output)} tokens · ${tps} tok/s`)}`);
      }
      if (u.cached) ui.println(`  ${c.muted(L(`de la entrada, ${formatTokens(u.cached)} salieron de la caché (no se volvieron a procesar)`, `of the input, ${formatTokens(u.cached)} came from cache (not processed again)`))}`);
      const cloud = resolveProvider(runtime.settings, runtime.settings.provider)?.cloud;
      ui.hint(L(
        `¿Por qué la entrada es grande? Cada petición reenvía las instrucciones y la conversación (el modelo no recuerda entre peticiones), y cada paso con herramientas es una petición. ${runtime.isLean() ? 'Modo ligero activo: instrucciones recortadas.' : 'Activa el modo ligero en /config para reducirlo.'}`,
        `Why is input large? Each request re-sends the instructions and the conversation (the model has no memory between requests), and each tool step is a request. ${runtime.isLean() ? 'Lean mode on: trimmed instructions.' : 'Enable lean mode in /config to reduce it.'}`,
      ));
      ui.hint(cloud ? L('Proveedor en la nube: revisa la tarifa de tu proveedor.', 'Cloud provider: check your provider pricing.') : L('Modelo local o PC propia: costo de nube $0 (solo tiempo de cómputo).', 'Local model or your own PC: $0 cloud cost (compute time only).'));
    },
  },

  resume: {
    get description() { return L('Retoma una conversación anterior de este directorio', 'Resume a previous conversation from this folder'); },
    async run(a, { runtime, repl }) {
      const list = Session.list(runtime.cwd, 15);
      if (!list.length) return ui.hint(L('No hay conversaciones guardadas en este directorio.', 'No saved conversations in this folder.'));
      const id = await select(repl.input, { title: L('Conversaciones', 'Conversations'), options: list.map((s) => ({ label: s.title || L('(sin título)', '(untitled)'), value: s.id, hint: `${new Date(s.updated).toLocaleString()} · ${s.count} ${L('mensajes', 'messages')}` })) });
      if (id) repl.resume(id);
    },
  },

  rewind: {
    get description() { return L('Vuelve a un punto anterior (código y/o conversación)', 'Go back to an earlier point (code and/or conversation)'); },
    async run(a, { runtime, repl }) {
      const cps = runtime.checkpoints.list();
      if (!cps.length) return ui.hint(L('Todavía no hay puntos de control en esta sesión.', 'No checkpoints in this session yet.'));
      const idx = await select(repl.input, { title: L('Volver a antes de…', 'Go back to before…'), options: cps.slice().reverse().map((cp) => ({ label: cp.prompt || '—', value: cp.index, hint: `${new Date(cp.time).toLocaleTimeString()} · ${cp.files} ${L('archivos', 'files')}` })) });
      if (idx == null) return;
      const what = await select(repl.input, { title: L('¿Qué restauro?', 'What should I restore?'), options: [{ label: L('Código y conversación', 'Code and conversation'), value: 'both' }, { label: L('Solo la conversación', 'Conversation only'), value: 'conv' }, { label: L('Solo el código', 'Code only'), value: 'code' }] });
      if (!what) return;
      const msgIndex = cps[idx].messageIndex;
      const r = runtime.checkpoints.rewind(idx, { restoreFiles: what !== 'conv' });
      if (what !== 'code') { repl.agent.messages.length = msgIndex; repl.session.save(); }
      ui.success(`${L('Restaurado', 'Restored')}${r.restored.length ? `: ${r.restored.map((f) => relPath(f, runtime.cwd)).join(', ')}` : ''}.`);
    },
  },

  todos: {
    get description() { return L('Muestra la lista de tareas actual', 'Show the current task list'); },
    async run(a, { runtime }) {
      if (!runtime.todos.length) return ui.hint(L('No hay tareas.', 'No tasks.'));
      ui.printTodos(runtime.todos);
    },
  },

  toolmode: {
    get description() { return L('Modo de herramientas: auto, native o prompt', 'Tool mode: auto, native or prompt'); },
    argumentHint: '[auto|native|prompt]',
    async run(args, { runtime }) {
      const m = args.trim();
      if (!['auto', 'native', 'prompt'].includes(m)) return ui.println(L(`Modo actual: ${runtime.settings.toolMode}. Opciones: auto, native, prompt (para modelos sin tool calling).`, `Current mode: ${runtime.settings.toolMode}. Options: auto, native, prompt (for models without tool calling).`));
      runtime.save('toolMode', m);
      ui.success(`${L('Modo de herramientas', 'Tool mode')}: ${m}`);
    },
  },

  offline: {
    get description() { return L('Activa o desactiva el modo sin red', 'Toggle offline mode'); },
    async run(a, { runtime }) {
      runtime.save('offline', !runtime.offline);
      ui.success(runtime.offline ? L('Modo offline activado.', 'Offline mode on.') : L('Modo offline desactivado.', 'Offline mode off.'));
    },
  },

  config: {
    get description() { return L('Ver o cambiar ajustes (get/set)', 'View or change settings (get/set)'); },
    argumentHint: '[get <key> | set <key> <value> [--project]]',
    async run(args, { runtime }) {
      const [sub, key, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (sub === 'set' && key) {
        const project = rest.includes('--project');
        const raw = rest.filter((x) => x !== '--project').join(' ');
        let value = raw;
        try { value = JSON.parse(raw); } catch { /* texto */ }
        const f = runtime.save(key, value, project ? 'project' : 'user');
        return ui.success(`${key} = ${JSON.stringify(value)} (${f})`);
      }
      if (sub === 'get' && key) return ui.println(JSON.stringify(key.split('.').reduce((o, k) => o?.[k], runtime.settings), null, 2));
      const s = runtime.settings;
      ui.box([
        `${c.dim(L('proveedor     ', 'provider      '))}${s.provider}`, `${c.dim(L('modelo        ', 'model         '))}${s.model || '—'}`, `${c.dim(L('tema          ', 'theme         '))}${runtime.themeName()}`,
        `${c.dim(L('idioma        ', 'language      '))}${s.language}`, `${c.dim(L('contexto      ', 'context       '))}${s.contextWindow} tokens`,
      ], { title: c.accent(L('Configuración', 'Settings'), { bold: true }) });
      ui.hint(L('Cambia valores con /config set <clave> <valor>. Ej: /config set contextWindow 32768', 'Change values with /config set <key> <value>. E.g. /config set contextWindow 32768'));
    },
  },

  reload: {
    get description() { return L('Recarga ajustes, skills, agentes, comandos y plugins', 'Reload settings, skills, agents, commands and plugins'); },
    async run(a, { runtime }) { runtime.reload(); ui.success(`${L('Recargado', 'Reloaded')}: ${Object.keys(runtime.skills).length} skills · ${Object.keys(runtime.agents).length} ${L('agentes', 'agents')} · ${Object.keys(runtime.commands).length} ${L('comandos', 'commands')}.`); },
  },

  doctor: {
    get description() { return L('Diagnostica la instalación y la conexión', 'Diagnose installation and connection'); },
    async run(a, { runtime }) {
      const ok = (t) => ui.println(`  ${c.success('✓')} ${t}`);
      const bad = (t, fix) => ui.println(`  ${c.error('✗')} ${t}${fix ? c.dim(` → ${fix}`) : ''}`);
      ui.println(c.accent(`${APP_NAME} ${VERSION}`, { bold: true }));
      const major = Number(process.versions.node.split('.')[0]);
      (major >= 18 ? ok : bad)(`Node.js ${process.versions.node}`, L('instala Node 18 o superior', 'install Node 18 or newer'));
      ok(`${L('Shell para Bash', 'Shell for Bash')}: ${shellLabel(detectShell(runtime.settings))}`);
      ok(`${L('Configuración', 'Settings')}: ${HOME}`);
      const p = runtime.providerInfo();
      if (!p) bad(L(`Proveedor "${runtime.settings.provider}" desconocido`, `Unknown provider "${runtime.settings.provider}"`), '/setup');
      else {
        try {
          const models = await runtime.createClient({ model: runtime.settings.model || 'x' }).listModels();
          ok(L(`${p.label || runtime.settings.provider} responde · ${models.length} modelos`, `${p.label || runtime.settings.provider} is reachable · ${models.length} models`));
          if (runtime.settings.model && !models.some((m) => m.id === runtime.settings.model)) bad(L(`El modelo "${runtime.settings.model}" no está en el proveedor`, `Model "${runtime.settings.model}" is not on the provider`), '/models');
        } catch {
          bad(L(`${p.label || runtime.settings.provider} no responde`, `${p.label || runtime.settings.provider} is not reachable`), '/setup');
        }
      }
      if (!runtime.settings.model) bad(L('No hay modelo elegido', 'No model selected'), '/setup');
      for (const s of runtime.mcp.status()) (s.status === 'conectado' ? ok : bad)(`MCP ${s.name}${s.error ? ` (${s.error})` : ''}`);
      for (const w of runtime.themeWarnings || []) bad(`${L('Contraste del tema', 'Theme contrast')}: ${w}`, '/accessibility');
      ok(`${Object.keys(runtime.agents).length} ${L('agentes', 'agents')} · ${Object.keys(runtime.skills).length} skills · ${runtime.plugins.length} plugins`);
    },
  },

  status: {
    get description() { return L('Resumen de la sesión actual', 'Current session summary'); },
    async run(a, { runtime, repl }) {
      ui.println(runtime.statusLine(repl.agent));
      ui.hint(`${L('Sesión', 'Session')} ${repl.session.id} · ${repl.agent.messages.length} ${L('mensajes', 'messages')} · ${runtime.cwd}`);
    },
  },

  bench: {
    get description() { return L('Mide velocidad y soporte de herramientas de tus modelos', 'Measure speed and tool support of your models'); },
    argumentHint: '[model…]',
    async run(args, { runtime }) {
      const { bench } = await import('../remote.js');
      await bench(args.trim() ? args.trim().split(/\s+/) : [], {}, runtime);
      runtime.toolModes = {};
    },
  },

  connect: {
    get description() { return L('Conecta con una PC que ejecuta "codice serve"', 'Connect to a PC running "codice serve"'); },
    argumentHint: '<url> <token> [name]',
    async run(args, { runtime }) {
      const [url, token, name] = args.trim().split(/\s+/);
      const { connect } = await import('../remote.js');
      await connect([url], { token, name: name || 'pc-remota' }, runtime);
    },
  },

  version: { get description() { return L('Versión de Códice', 'Códice version'); }, async run() { ui.println(`codice ${VERSION}`); } },
};

// Asistente para crear un agente (el modelo puede generarlo a partir de una descripción).
async function createAgentWizard({ runtime, repl }) {
  const scope = await select(repl.input, { title: L('¿Dónde guardo el agente?', 'Where should I save the agent?'), options: [{ label: L('Proyecto (.codice/agents)', 'Project (.codice/agents)'), value: 'proyecto' }, { label: L('Usuario (~/.codice/agents, todos los proyectos)', 'User (~/.codice/agents, all projects)'), value: 'usuario' }] });
  if (!scope) return;
  const desc = await repl.input.question(`${c.accent('›')} ${L('Describe qué debe hacer el agente y cuándo usarlo', 'Describe what the agent should do and when to use it')}: `);
  if (!desc?.trim()) return ui.hint(L('Cancelado.', 'Cancelled.'));
  const how = await select(repl.input, { title: L('¿Cómo lo creo?', 'How should I create it?'), options: [{ label: L('Generarlo con el modelo (recomendado)', 'Generate it with the model (recommended)'), value: 'ai' }, { label: L('Escribirlo yo', 'Write it myself'), value: 'manual' }] });
  if (!how) return;
  let def;
  if (how === 'ai') {
    runtime.spinner.start(L('Diseñando el agente…', 'Designing the agent…'));
    try {
      const r = await runtime.createClient().chat({
        messages: [
          { role: 'system', content: 'You design specialized subagents for a coding assistant. Reply ONLY with JSON: {"name": "kebab-case-name", "description": "when to use it (one sentence, English)", "tools": ["Read","Glob","Grep","LS","Edit","Write","Bash","WebFetch"] or [] for all tools, "prompt": "detailed system prompt in English: role, step-by-step method, constraints and the format of the final report"}. Give read-only agents only read tools.' },
          { role: 'user', content: desc },
        ],
      });
      runtime.spinner.stop();
      const text = stripThinking(r.content);
      def = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    } catch (e) {
      runtime.spinner.stop();
      ui.warn(L(`No pude generarlo automáticamente (${e.message}). Continúo en modo manual.`, `Could not generate it automatically (${e.message}). Continuing manually.`));
    }
  }
  if (!def) {
    const name = await repl.input.question(`${c.accent('›')} ${L('Nombre (ej. revisor-sql)', 'Name (e.g. sql-reviewer)')}: `);
    const tools = await repl.input.question(`${c.accent('›')} ${L('Herramientas separadas por coma (vacío = todas)', 'Comma-separated tools (empty = all)')}: `);
    def = { name: name || 'my-agent', description: desc, tools: tools ? tools.split(',').map((t) => t.trim()).filter(Boolean) : [], prompt: `You are a specialist. ${desc}\n\nFinish with a concise report of what you did.` };
  }
  ui.box([`${c.agent(def.name, { bold: true })}`, c.muted(def.description), `${c.dim(L('herramientas ', 'tools '))}${def.tools?.length ? def.tools.join(', ') : L('todas', 'all')}`, '', ...String(def.prompt).split('\n').slice(0, 12).map((l) => c.primary(l))], { title: c.accent(L('Nuevo agente', 'New agent')) });
  if (!(await confirm(repl.input, L('¿Guardar este agente?', 'Save this agent?')))) return;
  const file = saveAgent(scope, runtime.projectRoot, def);
  runtime.reload();
  ui.success(L(`Agente guardado en ${file}.`, `Agent saved to ${file}.`));
}

// Personalización (/theme, /mascot, /accessibility y panel /config).
const legacyConfig = BUILTIN_COMMANDS.config.run;
Object.assign(BUILTIN_COMMANDS, customizeCommands({ legacyConfig }));
