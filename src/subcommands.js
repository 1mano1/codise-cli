// Subcomandos de la CLI que no abren la consola interactiva.
import { Runtime } from './runtime.js';
import { c } from './ui/theme.js';
import * as ui from './ui/output.js';
import { BUILTIN_COMMANDS } from './commands/builtin.js';
import { installPlugin, removePlugin, listPlugins } from './plugins.js';

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
        if (!models.length) console.log(c.warning('Sin modelos.'));
        return 0;
      } catch (e) {
        ui.errorBox(`No se pudo conectar con ${rt.settings.provider}`, e.message, rt.settings.provider === 'ollama' ? 'Ejecuta "ollama serve"' : 'Revisa la URL del proveedor');
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
        if (!name || !rest.length) { console.error('Uso: codice mcp add <nombre> <comando> [args…] | codice mcp add <nombre> --url <url>'); return 2; }
        const cfg = rest[0] === '--url' || o.url ? { type: 'http', url: rest[1] || o.url } : { command: rest[0], args: rest.slice(1) };
        rt.save(`mcpServers.${name}`, cfg, o.project ? 'project' : 'user');
        ui.success(`MCP ${name} añadido.`);
        return 0;
      }
      if (action === 'remove') { rt.save(`mcpServers.${name}`, undefined, o.project ? 'project' : 'user'); ui.success(`MCP ${name} eliminado.`); return 0; }
      await rt.startMcp();
      await BUILTIN_COMMANDS.mcp.run('', ctx);
      rt.mcp.stopAll();
      return 0;
    }
    case 'plugin':
    case 'plugins': {
      const [action, target] = args;
      try {
        if (action === 'install') { const p = installPlugin(target); rt.save(`enabledPlugins.${p.name}`, true); ui.success(`Plugin ${p.name} instalado.`); return 0; }
        if (action === 'remove') { removePlugin(target); ui.success(`Plugin ${target} eliminado.`); return 0; }
      } catch (e) { ui.errorBox('Error con el plugin', e.message); return 1; }
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
      if (!mod) { console.error(`"${sub}" no está disponible en esta versión.`); return 2; }
      return mod.runRemote(sub, args, o, rt);
    }
    default:
      console.error(`Subcomando desconocido: ${sub}`);
      return 2;
  }
}
