// Subcomandos de la CLI que no abren la consola interactiva.
import { Runtime } from './runtime.js';
import { c } from './ui/theme.js';
import * as ui from './ui/output.js';
import { BUILTIN_COMMANDS } from './commands/builtin.js';
import { installPlugin, removePlugin, listPlugins } from './plugins.js';
import { L } from './i18n.js';

function runtimeFrom(o) {
  return new Runtime({ cwd: process.cwd(), overrides: { model: o.model, provider: o.provider, baseUrl: o['base-url'], apiKey: o['api-key'], providerType: o['provider-type'] } });
}

export async function runSubcommand(sub, args, o) {
  const rt = runtimeFrom(o);
  const ctx = { runtime: rt, repl: { input: null, agent: null, showError: (e) => ui.errorBox('Error', e.message) } };
  switch (sub) {
    case 'models': {
      try {
        const models = await rt.createClient({ model: rt.settings.model || 'x' }).listModels();
        for (const m of models) console.log(`${m.id === rt.settings.model ? c.success('●') : ' '} ${m.id}${m.size ? c.dim(`  ${(m.size / 1e9).toFixed(1)} GB`) : ''}`);
        if (!models.length) console.log(c.warning(L('Sin modelos.', 'No models.')));
        return 0;
      } catch (e) {
        ui.errorBox(L(`No pude conectar con ${rt.settings.provider}`, `Could not connect to ${rt.settings.provider}`), e.message, L('Revisa la conexión con “codice” → /setup, o con “codice doctor”.', 'Check the connection with “codice” → /setup, or “codice doctor”.'));
        return 1;
      }
    }
    case 'doctor':
      await rt.startMcp();
      await BUILTIN_COMMANDS.doctor.run('', ctx);
      rt.mcp.stopAll();
      return 0;
    case 'mcp': {
      const [action, name, ...rest] = args;
      if (action === 'add') {
        if (!name || !rest.length) { console.error(L('Uso: codice mcp add <nombre> <comando> [args…] | codice mcp add <nombre> --url <url>', 'Usage: codice mcp add <name> <command> [args…] | codice mcp add <name> --url <url>')); return 2; }
        const cfg = rest[0] === '--url' || o.url ? { type: 'http', url: rest[1] || o.url } : { command: rest[0], args: rest.slice(1) };
        rt.save(`mcpServers.${name}`, cfg, o.project ? 'project' : 'user');
        ui.success(L(`MCP ${name} añadido.`, `MCP ${name} added.`));
        return 0;
      }
      if (action === 'remove') { rt.save(`mcpServers.${name}`, undefined, o.project ? 'project' : 'user'); ui.success(L(`MCP ${name} eliminado.`, `MCP ${name} removed.`)); return 0; }
      await rt.startMcp();
      await BUILTIN_COMMANDS.mcp.run('', ctx);
      rt.mcp.stopAll();
      return 0;
    }
    case 'plugin':
    case 'plugins': {
      const [action, target] = args;
      try {
        if (action === 'install') { const p = installPlugin(target); rt.save(`enabledPlugins.${p.name}`, true); ui.success(L(`Plugin ${p.name} instalado.`, `Plugin ${p.name} installed.`)); return 0; }
        if (action === 'remove') { removePlugin(target); ui.success(L(`Plugin ${target} eliminado.`, `Plugin ${target} removed.`)); return 0; }
      } catch (e) { ui.errorBox(L('Error con el plugin', 'Plugin error'), e.message); return 1; }
      for (const p of listPlugins(rt.settings)) console.log(`${p.enabled ? c.success('●') : c.dim('○')} ${p.name} ${c.dim(p.version)}  ${c.muted(p.description)}`);
      return 0;
    }
    case 'agents':
      for (const a of Object.values(rt.agents)) console.log(`${c.agent(a.name.padEnd(24))}${c.muted(a.description.slice(0, 90))} ${c.dim(`· ${a.source}`)}`);
      return 0;
    case 'config': {
      const [action, key, ...rest] = args;
      if (action === 'set' && key) {
        let value = rest.join(' ');
        try { value = JSON.parse(value); } catch { /* texto */ }
        const f = rt.save(key, value, o.project ? 'project' : 'user');
        ui.success(`${key} = ${JSON.stringify(value)} (${f})`);
        return 0;
      }
      const v = key ? key.split('.').reduce((x, k) => x?.[k], rt.settings) : rt.settings;
      console.log(JSON.stringify(v, null, 2));
      return 0;
    }
    case 'serve':
    case 'connect':
    case 'bench': {
      const mod = await import('./remote.js').catch(() => null);
      if (!mod) { console.error(L(`"${sub}" no está disponible en esta versión.`, `"${sub}" is not available in this version.`)); return 2; }
      return mod.runRemote(sub, args, o, rt);
    }
    default:
      console.error(L(`Subcomando desconocido: ${sub}`, `Unknown subcommand: ${sub}`));
      return 2;
  }
}
