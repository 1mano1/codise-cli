// Comandos "/" integrados.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { c, style } from '../ui/theme.js';
import * as ui from '../ui/output.js';
import { select, confirm } from '../ui/select.js';
import { listProviderNames, resolveProvider, PRESETS, VERSION, HOME, APP_NAME } from '../config.js';
import { MODES, MODE_INFO } from '../permissions.js';
import { installPlugin, removePlugin, listPlugins } from '../plugins.js';
import { saveAgent } from '../resources.js';
import { addMemory, memoryFiles } from '../memory.js';
import { Session } from '../session.js';
import { detectShell, shellLabel } from '../tools/bash.js';
import { formatTokens, formatDuration, relPath } from '../util/fs.js';
import { stripThinking } from '../llm/stream.js';

const fmtSize = (b) => (b ? `${(b / 1e9).toFixed(1)} GB` : '');

function openInEditor(file) {
  const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'nano');
  spawn(editor, [file], { stdio: 'inherit', shell: process.platform === 'win32', detached: process.platform === 'win32' });
}

export const BUILTIN_COMMANDS = {
  help: {
    description: 'Muestra los comandos y atajos',
    async run(args, { runtime, repl }) {
      ui.println(c.accent('Comandos', { bold: true }));
      for (const cmd of repl.commandList()) ui.println(`  ${c.accent(cmd.name.padEnd(22))}${c.muted(cmd.description)}${cmd.source !== 'integrado' ? c.dim(`  · ${cmd.source}`) : ''}`);
      ui.println('');
      ui.println(c.accent('Atajos', { bold: true }));
      const keys = [['!comando', 'ejecuta en el shell y añade la salida al contexto'], ['#texto', 'guarda una nota en CODICE.md'], ['@ruta', 'adjunta un archivo o carpeta'], ['\\ + enter', 'nueva línea'], ['shift+tab', 'cambia el modo de permisos'], ['esc', 'interrumpe al agente'], ['ctrl+o', 'muestra la salida completa de la última herramienta'], ['ctrl+c ×2', 'salir']];
      for (const [k, d] of keys) ui.println(`  ${c.accent(k.padEnd(22))}${c.muted(d)}`);
      ui.println('');
      ui.hint(`Tema: ${runtime.themeName()} · Mascota: ${runtime.mascot()?.name || 'ninguna'} · Config: ${path.join(HOME, 'settings.json')}`);
    },
  },

  exit: { description: 'Salir de Códice', aliases: ['quit', 'salir'], async run(a, { repl }) { await repl.exit(); } },

  clear: {
    description: 'Empieza una conversación nueva',
    aliases: ['new', 'reset'],
    async run(a, { repl }) { repl.newSession(); ui.success('Conversación nueva.'); },
  },

  model: {
    description: 'Cambia el modelo (sin argumentos: elegir de la lista)',
    argumentHint: '[proveedor:]modelo',
    async run(args, ctx) {
      const { runtime } = ctx;
      if (!args) return BUILTIN_COMMANDS.models.run('', ctx);
      let provider = runtime.settings.provider, model = args.trim();
      const i = model.indexOf(':');
      if (i > 0 && listProviderNames(runtime.settings).includes(model.slice(0, i))) { provider = model.slice(0, i); model = model.slice(i + 1); }
      runtime.save('provider', provider);
      runtime.save('model', model);
      ui.success(`Modelo: ${c.soft(model, { bold: true })} ${c.muted(`vía ${provider}`)}`);
    },
  },

  models: {
    description: 'Lista los modelos del proveedor actual y permite elegir',
    async run(args, { runtime, repl }) {
      const client = runtime.createClient();
      let models;
      runtime.spinner.start('Consultando modelos…');
      try { models = await client.listModels(); } catch (e) { runtime.spinner.stop(); return repl.showError(e); }
      runtime.spinner.stop();
      if (!models.length) return ui.warn(`El proveedor ${runtime.settings.provider} no tiene modelos. ${runtime.settings.provider === 'ollama' ? 'Descarga uno con: ollama pull qwen2.5-coder:7b' : ''}`);
      const current = runtime.settings.model;
      const options = models.map((m) => {
        const mode = runtime.toolModes[m.id] || '';
        return { label: m.id, value: m.id, hint: [fmtSize(m.size), m.id === current ? 'actual' : '', mode === 'prompt' ? '◇ modo prompt' : ''].filter(Boolean).join(' · '), hintColor: m.id === current ? 'status/success' : 'text/dim' };
      });
      const choice = await select(repl.input, { title: `Modelos en ${c.primary(runtime.settings.provider, { bold: true })}`, options, initial: Math.max(0, models.findIndex((m) => m.id === current)) });
      if (!choice) return;
      runtime.save('model', choice);
      ui.success(`Modelo cambiado a ${c.soft(choice, { bold: true })}`);
    },
  },

  provider: {
    description: 'Cambia de proveedor (local, nube o PC remota) o añade uno',
    argumentHint: '[nombre] | add <nombre> <url> [ollama|openai|codice] [ENV_API_KEY]',
    async run(args, { runtime, repl }) {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (sub === 'add') {
        const [name, url, type = 'openai', keyEnv] = rest;
        if (!name || !url) return ui.warn('Uso: /provider add <nombre> <url> [ollama|openai|codice] [VARIABLE_API_KEY]');
        runtime.save(`providers.${name}`, { type, baseUrl: url, ...(keyEnv ? { apiKeyEnv: keyEnv } : {}) });
        return ui.success(`Proveedor ${name} añadido (${type}, ${url}). Actívalo con /provider ${name}`);
      }
      if (sub === 'remove') {
        runtime.save(`providers.${rest[0]}`, undefined);
        return ui.success(`Proveedor ${rest[0]} eliminado.`);
      }
      let name = sub;
      if (!name) {
        const options = listProviderNames(runtime.settings).map((n) => {
          const p = resolveProvider(runtime.settings, n);
          const kind = p.type === 'codice' ? 'PC remota' : p.cloud ? 'nube' : 'local';
          const key = p.cloud && !p.apiKey ? c.warning(' sin API key') : '';
          return { label: `${n.padEnd(12)} ${c.dim(p.baseUrl)}`, value: n, hint: `${kind}${n === runtime.settings.provider ? ' · actual' : ''}`, hintColor: n === runtime.settings.provider ? 'status/success' : 'text/dim', keyWarn: key };
        });
        name = await select(repl.input, { title: 'Proveedor', options, initial: Math.max(0, options.findIndex((o) => o.value === runtime.settings.provider)) });
        if (!name) return;
      }
      const p = resolveProvider(runtime.settings, name);
      if (!p) return ui.warn(`No conozco el proveedor "${name}". Añádelo con /provider add.`);
      if (p.cloud && !p.apiKey) ui.warn(`Falta la API key: define la variable de entorno ${p.apiKeyEnv}.`);
      runtime.save('provider', name);
      ui.success(`Proveedor: ${name} (${p.baseUrl})`);
      await BUILTIN_COMMANDS.models.run('', { runtime, repl });
    },
  },

  mode: {
    description: 'Modo de permisos: default, acceptEdits, plan o bypass',
    argumentHint: '[modo]',
    async run(args, { runtime, repl }) {
      let m = args.trim();
      if (!m) {
        m = await select(repl.input, { title: 'Modo de permisos', options: MODES.map((x) => ({ label: MODE_INFO[x].label, value: x, hint: MODE_INFO[x].hint })), initial: MODES.indexOf(runtime.permissionMode) });
        if (!m) return;
      }
      if (!MODES.includes(m)) return ui.warn(`Modos válidos: ${MODES.join(', ')}`);
      runtime.setPermissionMode(m);
      ui.success(`Modo: ${MODE_INFO[m].label} — ${MODE_INFO[m].hint}`);
    },
  },

  permissions: {
    description: 'Ver o editar reglas de permisos',
    argumentHint: '[allow|deny|remove] <regla>',
    async run(args, { runtime }) {
      const [sub, ...rest] = args.trim().split(/\s+/);
      const rule = rest.join(' ');
      const p = runtime.settings.permissions;
      if ((sub === 'allow' || sub === 'deny') && rule) {
        runtime.save(`permissions.${sub}`, [...new Set([...(runtime.localSettings.permissions?.[sub] || []), rule])], 'local');
        return ui.success(`Regla ${sub} añadida: ${rule}`);
      }
      if (sub === 'remove' && rule) {
        for (const k of ['allow', 'deny']) runtime.save(`permissions.${k}`, (runtime.localSettings.permissions?.[k] || []).filter((r) => r !== rule), 'local');
        runtime.permissions.sessionAllow = runtime.permissions.sessionAllow.filter((r) => r !== rule);
        return ui.success(`Regla eliminada: ${rule}`);
      }
      ui.println(`${c.primary('Modo:', { bold: true })} ${MODE_INFO[runtime.permissionMode].label}`);
      ui.println(c.success('Permitidas', { bold: true }));
      for (const r of [...p.allow, ...runtime.permissions.sessionAllow]) ui.println(`  ${c.success('✓')} ${r}`);
      ui.println(c.error('Bloqueadas', { bold: true }));
      for (const r of p.deny) ui.println(`  ${c.error('✗')} ${r}`);
      ui.hint('Ejemplos: /permissions allow Bash(npm test:*) · /permissions deny Bash(rm -rf:*)');
    },
  },

  tools: {
    description: 'Lista las herramientas disponibles',
    async run(a, { repl }) {
      for (const t of repl.agent.tools()) {
        const tag = t.mcp ? c.info('MCP') : t.readOnly ? c.dim('lectura') : t.edits ? c.warning('edición') : c.warning('acción');
        ui.println(`  ${style(t.name.padEnd(28), { bold: true, fg: 'text/primary' })}${tag}  ${c.muted(String(t.describe ? t.description : t.description).split('\n')[0].slice(0, 80))}`);
      }
    },
  },

  mcp: {
    description: 'Servidores MCP: estado, add, remove, restart',
    argumentHint: '[add <nombre> <comando…> | add <nombre> --url <url> | remove <nombre> | restart]',
    async run(args, { runtime }) {
      const [sub, name, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (sub === 'add') {
        if (!name || !rest.length) return ui.warn('Uso: /mcp add <nombre> <comando> [args…]   o   /mcp add <nombre> --url https://…');
        const cfg = rest[0] === '--url' ? { type: 'http', url: rest[1] } : { command: rest[0], args: rest.slice(1) };
        runtime.save(`mcpServers.${name}`, cfg);
        runtime.spinner.start(`Conectando ${name}…`);
        const cl = await runtime.mcp.restart(name, cfg);
        runtime.spinner.stop();
        return cl.status === 'conectado' ? ui.success(`MCP ${name} conectado · ${cl.tools.length} herramientas`) : ui.errorBox(`No se pudo conectar ${name}`, cl.error, 'Revisa el comando o la URL con /mcp');
      }
      if (sub === 'remove') {
        runtime.save(`mcpServers.${name}`, undefined);
        runtime.mcp.clients.get(name)?.close();
        runtime.mcp.clients.delete(name);
        return ui.success(`MCP ${name} eliminado.`);
      }
      if (sub === 'restart') {
        runtime.mcp.stopAll();
        runtime.spinner.start('Reconectando servidores MCP…');
        await runtime.startMcp();
        runtime.spinner.stop();
      }
      const st = runtime.mcp.status();
      if (!st.length) return ui.hint('No hay servidores MCP. Añade uno: /mcp add filesystem npx -y @modelcontextprotocol/server-filesystem .');
      for (const s of st) {
        const icon = s.status === 'conectado' ? c.info('◆') : c.error('✗');
        ui.println(`  ${icon} ${style(s.name, { bold: true, fg: 'text/primary' })}  ${s.status === 'conectado' ? c.muted(`${s.tools} herramientas${s.server ? ` · ${s.server}` : ''}`) : c.error(s.error || s.status)}`);
      }
    },
  },

  plugin: {
    description: 'Plugins: install, remove, enable, disable, list',
    aliases: ['plugins'],
    argumentHint: '[install <ruta|git|usuario/repo|plugin@marketplace> | remove | enable | disable <nombre>]',
    async run(args, { runtime }) {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const target = rest.join(' ');
      try {
        if (sub === 'install' && target) {
          runtime.spinner.start('Instalando plugin…');
          const p = installPlugin(target);
          runtime.spinner.stop();
          runtime.save(`enabledPlugins.${p.name}`, true);
          await runtime.startMcp();
          return ui.success(`Plugin ${p.name}${p.version ? ` v${p.version}` : ''} instalado. ${p.description}`);
        }
        if (sub === 'remove' && target) { removePlugin(target); runtime.save(`enabledPlugins.${target}`, undefined); return ui.success(`Plugin ${target} eliminado.`); }
        if ((sub === 'enable' || sub === 'disable') && target) { runtime.save(`enabledPlugins.${target}`, sub === 'enable'); return ui.success(`Plugin ${target} ${sub === 'enable' ? 'activado' : 'desactivado'}.`); }
      } catch (e) {
        runtime.spinner.stop();
        return ui.errorBox('No se pudo completar la operación', e.message);
      }
      const all = listPlugins(runtime.settings);
      if (!all.length) return ui.hint('No hay plugins. Prueba: /plugin install <ruta o repositorio>');
      for (const p of all) ui.println(`  ${p.enabled ? c.success('●') : c.dim('○')} ${style(p.name, { bold: true, fg: 'text/primary' })} ${c.dim(p.version)}  ${c.muted(p.description)}`);
    },
  },

  skills: {
    description: 'Lista las skills instaladas',
    async run(a, { runtime }) {
      const list = Object.values(runtime.skills);
      if (!list.length) return ui.hint(`No hay skills. Crea una en ${path.join(HOME, 'skills', '<nombre>', 'SKILL.md')} o en .codice/skills/`);
      for (const s of list) ui.println(`  ${c.agent(s.name.padEnd(28), { bold: true })}${c.muted(s.description.slice(0, 90))} ${c.dim(`· ${s.source}`)}`);
    },
  },

  agents: {
    description: 'Agentes y subagentes: listar, ver, crear, editar, borrar, asignar modelo',
    argumentHint: '[new]',
    async run(args, ctx) {
      const { runtime, repl } = ctx;
      if (args.trim() === 'new' || args.trim() === 'nuevo') return createAgentWizard(ctx);
      const list = Object.values(runtime.agents);
      const options = [{ label: c.accent('+ Crear un agente nuevo'), value: '__new__' }, ...list.map((a) => ({ label: a.name, value: a.name, hint: `${a.source}${runtime.settings.agentModels?.[a.name] || a.model ? ` · ${runtime.settings.agentModels?.[a.name] || a.model}` : ''}` }))];
      const pick = await select(repl.input, { title: 'Agentes', options });
      if (!pick) return;
      if (pick === '__new__') return createAgentWizard(ctx);
      const a = runtime.agents[pick];
      ui.box([
        `${c.agent(a.name, { bold: true })} ${c.dim(`· ${a.source}`)}`,
        c.muted(a.description),
        `${c.dim('herramientas ')}${a.tools?.join(', ') || 'todas'}`,
        `${c.dim('modelo       ')}${runtime.settings.agentModels?.[a.name] || a.model || 'el de la sesión'}`,
        `${c.dim('archivo      ')}${c.info(a.file)}`,
      ]);
      const editable = a.source !== 'incluido' && !a.source.startsWith('plugin');
      const action = await select(repl.input, {
        title: '¿Qué quieres hacer?',
        options: [
          { label: 'Asignar un modelo a este agente', value: 'model' },
          { label: editable ? 'Editar el archivo' : 'Copiar a mis agentes para personalizarlo', value: 'edit' },
          ...(editable ? [{ label: 'Borrar', value: 'delete' }] : []),
          { label: 'Volver', value: null },
        ],
      });
      if (action === 'model') {
        const m = await repl.input.question(`${c.accent('›')} Modelo para ${a.name} (proveedor:modelo, vacío = el de la sesión): `);
        runtime.save(`agentModels.${a.name}`, m?.trim() || undefined);
        ui.success(m?.trim() ? `${a.name} usará ${m.trim()}` : `${a.name} usará el modelo de la sesión`);
      } else if (action === 'edit') {
        let file = a.file;
        if (!editable) { file = saveAgent('usuario', runtime.projectRoot, { ...a, name: a.name.split(':').pop() }); runtime.reload(); ui.success(`Copiado a ${file}`); }
        openInEditor(file);
      } else if (action === 'delete') {
        if (await confirm(repl.input, `¿Borrar el agente ${a.name}?`)) { fs.unlinkSync(a.file); runtime.reload(); ui.success('Agente borrado.'); }
      }
    },
  },

  commands: {
    description: 'Lista los comandos personalizados',
    async run(a, { runtime }) {
      const list = Object.values(runtime.commands);
      if (!list.length) return ui.hint('No hay comandos personalizados. Crea un .md en ~/.codice/commands/ o .codice/commands/ (usa $ARGUMENTS).');
      for (const cmd of list) ui.println(`  ${c.accent(`/${cmd.name}`.padEnd(26))}${c.muted(cmd.description)} ${c.dim(`· ${cmd.source}`)}`);
    },
  },

  memory: {
    description: 'Memoria del proyecto (CODICE.md): ver, add, edit',
    argumentHint: '[add <texto> | edit]',
    async run(args, { runtime }) {
      const [sub, ...rest] = args.trim().split(/\s+/);
      if (sub === 'add' && rest.length) { const f = addMemory(runtime.projectRoot, rest.join(' ')); runtime.reload(); return ui.success(`Guardado en ${relPath(f, runtime.cwd)}`); }
      if (sub === 'edit') {
        const f = path.join(runtime.projectRoot, 'CODICE.md');
        if (!fs.existsSync(f)) fs.writeFileSync(f, '# Memoria del proyecto\n\n');
        return openInEditor(f);
      }
      const files = memoryFiles(runtime.cwd, runtime.projectRoot, { compat: runtime.settings.compat?.claude !== false });
      if (!files.length) return ui.hint('Sin memoria todavía. Usa /init para crear CODICE.md o escribe "# nota" para guardar algo.');
      for (const f of files) ui.println(`  ${c.success('●')} ${c.info(f.file)} ${c.dim(`· ${f.scope}`)}`);
    },
  },

  init: {
    description: 'Analiza el proyecto y crea CODICE.md',
    async run(args, { repl }) {
      await repl.runPrompt(`Analyze this codebase and create (or improve, if it exists) a CODICE.md file at the project root to guide future work. Include: what the project is, how to install/build/test/lint (exact commands), the architecture and key directories, and code conventions. Keep it concise and factual; do not invent anything. Write it in the user's language (Spanish by default). ${args}`.trim(), { display: '/init' });
    },
  },

  compact: {
    description: 'Resume la conversación para liberar contexto',
    argumentHint: '[instrucciones]',
    async run(args, { repl }) {
      const before = repl.agent.contextUsage().used;
      try {
        const s = await repl.agent.compact({ instructions: args });
        if (!s) return ui.hint('No hay suficiente conversación para compactar.');
        ui.success(`Conversación compactada: ${formatTokens(before)} → ${formatTokens(repl.agent.contextUsage().used)} tokens.`);
        repl.session.save();
      } catch (e) { repl.showError(e); }
    },
  },

  context: {
    description: 'Uso estimado del contexto',
    async run(a, { repl }) {
      const u = repl.agent.contextUsage();
      const pct = Math.min(100, Math.round((u.used / u.max) * 100));
      const bar = 30;
      const filled = Math.round((pct / 100) * bar);
      ui.println(`${c.accent('█'.repeat(filled))}${c.border('░'.repeat(bar - filled))} ${c.primary(`${pct} %`, { bold: true })}  ${c.muted(`${formatTokens(u.used)} / ${formatTokens(u.max)} tokens (sistema ${formatTokens(u.system)})`)}`);
      if (pct > 70) ui.hint('Usa /compact para resumir la conversación.');
    },
  },

  cost: {
    description: 'Tokens usados, velocidad y costo',
    aliases: ['usage', 'stats'],
    async run(a, { runtime }) {
      const u = runtime.usage;
      ui.println(`${c.primary('Sesión', { bold: true })}  ${c.muted(`${u.requests} peticiones · entrada ${formatTokens(u.input)} · salida ${formatTokens(u.output)} · ${formatDuration(u.ms)}`)}`);
      for (const [model, m] of Object.entries(u.byModel)) {
        const tps = m.ms ? (m.output / (m.ms / 1000)).toFixed(1) : '?';
        ui.println(`  ${c.soft(model.padEnd(36))}${c.muted(`${formatTokens(m.input + m.output)} tokens · ${tps} tok/s`)}`);
      }
      const cloud = resolveProvider(runtime.settings, runtime.settings.provider)?.cloud;
      ui.hint(cloud ? 'Proveedor en la nube: revisa la tarifa de tu proveedor.' : 'Modelo local o PC propia: costo de nube $0.');
    },
  },

  resume: {
    description: 'Retoma una conversación anterior de este directorio',
    async run(a, { runtime, repl }) {
      const list = Session.list(runtime.cwd, 15);
      if (!list.length) return ui.hint('No hay conversaciones guardadas en este directorio.');
      const id = await select(repl.input, { title: 'Conversaciones', options: list.map((s) => ({ label: s.title || '(sin título)', value: s.id, hint: `${new Date(s.updated).toLocaleString()} · ${s.count} mensajes` })) });
      if (id) repl.resume(id);
    },
  },

  rewind: {
    description: 'Vuelve a un punto anterior (código y/o conversación)',
    async run(a, { runtime, repl }) {
      const cps = runtime.checkpoints.list();
      if (!cps.length) return ui.hint('Todavía no hay puntos de control en esta sesión.');
      const idx = await select(repl.input, { title: 'Volver a antes de…', options: cps.slice().reverse().map((cp) => ({ label: cp.prompt || '(sin texto)', value: cp.index, hint: `${new Date(cp.time).toLocaleTimeString()} · ${cp.files} archivo${cp.files === 1 ? '' : 's'}` })) });
      if (idx == null) return;
      const what = await select(repl.input, { title: '¿Qué restauro?', options: [{ label: 'Código y conversación', value: 'both' }, { label: 'Solo la conversación', value: 'conv' }, { label: 'Solo el código', value: 'code' }] });
      if (!what) return;
      const msgIndex = cps[idx].messageIndex;
      const r = runtime.checkpoints.rewind(idx, { restoreFiles: what !== 'conv' });
      if (what !== 'code') { repl.agent.messages.length = msgIndex; repl.session.save(); }
      ui.success(`Restaurado${r.restored.length ? `: ${r.restored.map((f) => relPath(f, runtime.cwd)).join(', ')}` : ''}.`);
    },
  },

  todos: {
    description: 'Muestra la lista de tareas actual',
    async run(a, { runtime }) {
      if (!runtime.todos.length) return ui.hint('No hay tareas.');
      ui.printTodos(runtime.todos);
    },
  },

  toolmode: {
    description: 'Modo de herramientas: auto, native o prompt',
    argumentHint: '[auto|native|prompt]',
    async run(args, { runtime }) {
      const m = args.trim();
      if (!['auto', 'native', 'prompt'].includes(m)) return ui.println(`Modo actual: ${runtime.settings.toolMode}. Opciones: auto (detecta), native, prompt (<tool_call> en texto, para modelos sin tool calling).`);
      runtime.save('toolMode', m);
      ui.success(`Modo de herramientas: ${m}`);
    },
  },

  offline: {
    description: 'Activa o desactiva el modo sin red',
    async run(a, { runtime }) {
      runtime.save('offline', !runtime.offline);
      ui.success(runtime.offline ? 'Modo offline activado: herramientas de red desactivadas.' : 'Modo offline desactivado.');
    },
  },

  config: {
    description: 'Ver o cambiar ajustes (get/set)',
    argumentHint: '[get <clave> | set <clave> <valor> [--project]]',
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
        `${c.dim('proveedor     ')}${s.provider}`, `${c.dim('modelo        ')}${s.model || '—'}`, `${c.dim('tema          ')}${runtime.themeName()}`,
        `${c.dim('mascota       ')}${s.mascot?.name}`, `${c.dim('estilo        ')}${s.outputStyle}`, `${c.dim('contexto      ')}${s.contextWindow} tokens`,
        `${c.dim('herramientas  ')}${s.toolMode}`, `${c.dim('respaldo      ')}${(s.fallback || []).join(', ') || '—'}`,
      ], { title: c.accent('Configuración', { bold: true }) });
      ui.hint('Cambia valores con /config set <clave> <valor>. Ej: /config set contextWindow 32768');
    },
  },

  reload: {
    description: 'Recarga ajustes, skills, agentes, comandos y plugins',
    async run(a, { runtime }) { runtime.reload(); ui.success(`Recargado: ${Object.keys(runtime.skills).length} skills · ${Object.keys(runtime.agents).length} agentes · ${Object.keys(runtime.commands).length} comandos.`); },
  },

  doctor: {
    description: 'Diagnostica la instalación y la conexión',
    async run(a, { runtime }) {
      const ok = (t) => ui.println(`  ${c.success('✓')} ${t}`);
      const bad = (t, fix) => ui.println(`  ${c.error('✗')} ${t}${fix ? c.dim(` → ${fix}`) : ''}`);
      ui.println(c.accent(`${APP_NAME} ${VERSION}`, { bold: true }));
      const major = Number(process.versions.node.split('.')[0]);
      (major >= 18 ? ok : bad)(`Node.js ${process.versions.node}`, 'instala Node 18 o superior');
      ok(`Shell para Bash: ${shellLabel(detectShell(runtime.settings))}`);
      ok(`Configuración: ${HOME}`);
      const p = runtime.providerInfo();
      if (!p) bad(`Proveedor "${runtime.settings.provider}" desconocido`, '/provider');
      else {
        try {
          const models = await runtime.createClient().listModels();
          ok(`Proveedor ${runtime.settings.provider} (${p.baseUrl}) responde · ${models.length} modelos`);
          if (runtime.settings.model && !models.some((m) => m.id === runtime.settings.model)) bad(`El modelo "${runtime.settings.model}" no está en el proveedor`, '/models');
        } catch (e) {
          bad(`Proveedor ${runtime.settings.provider}: ${e.message}`, runtime.settings.provider === 'ollama' ? 'ejecuta "ollama serve"' : 'revisa la URL o la API key');
        }
      }
      if (!runtime.settings.model) bad('No hay modelo elegido', '/models');
      for (const s of runtime.mcp.status()) (s.status === 'conectado' ? ok : bad)(`MCP ${s.name}: ${s.status}${s.error ? ` (${s.error})` : ''}`);
      for (const w of runtime.themeWarnings || []) bad(`Contraste del tema: ${w}`, 'ajusta tu tema personalizado');
      ok(`${Object.keys(runtime.agents).length} agentes · ${Object.keys(runtime.skills).length} skills · ${runtime.plugins.length} plugins`);
    },
  },

  status: {
    description: 'Resumen de la sesión actual',
    async run(a, { runtime, repl }) {
      ui.println(runtime.statusLine(repl.agent));
      ui.hint(`Sesión ${repl.session.id} · ${repl.agent.messages.length} mensajes · directorio ${runtime.cwd}`);
    },
  },

  version: { description: 'Versión de Códice', async run() { ui.println(`codice ${VERSION}`); } },
};

// Asistente para crear un agente (el modelo puede generarlo a partir de una descripción).
async function createAgentWizard({ runtime, repl }) {
  const scope = await select(repl.input, { title: '¿Dónde guardo el agente?', options: [{ label: 'Proyecto (.codice/agents)', value: 'proyecto' }, { label: 'Usuario (~/.codice/agents, todos los proyectos)', value: 'usuario' }] });
  if (!scope) return;
  const desc = await repl.input.question(`${c.accent('›')} Describe qué debe hacer el agente y cuándo usarlo: `);
  if (!desc?.trim()) return ui.hint('Cancelado.');
  const how = await select(repl.input, { title: '¿Cómo lo creo?', options: [{ label: 'Generarlo con el modelo (recomendado)', value: 'ai' }, { label: 'Escribirlo yo', value: 'manual' }] });
  if (!how) return;
  let def;
  if (how === 'ai') {
    runtime.spinner.start('Diseñando el agente…');
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
      ui.warn(`No pude generarlo automáticamente (${e.message}). Continúo en modo manual.`);
    }
  }
  if (!def) {
    const name = await repl.input.question(`${c.accent('›')} Nombre (ej. revisor-sql): `);
    const tools = await repl.input.question(`${c.accent('›')} Herramientas separadas por coma (vacío = todas): `);
    def = { name: name || 'mi-agente', description: desc, tools: tools ? tools.split(',').map((t) => t.trim()).filter(Boolean) : [], prompt: `You are a specialist. ${desc}\n\nFinish with a concise report of what you did.` };
  }
  ui.box([`${c.agent(def.name, { bold: true })}`, c.muted(def.description), `${c.dim('herramientas ')}${def.tools?.length ? def.tools.join(', ') : 'todas'}`, '', ...String(def.prompt).split('\n').slice(0, 12).map((l) => c.primary(l))], { title: c.accent('Nuevo agente') });
  if (!(await confirm(repl.input, '¿Guardar este agente?'))) return;
  const file = saveAgent(scope, runtime.projectRoot, def);
  runtime.reload();
  ui.success(`Agente guardado en ${file}. Úsalo pidiéndole a Códice que delegue en "${def.name}".`);
}
