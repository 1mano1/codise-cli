// Configuración inicial (primera vez o /setup): idioma → tema → cómo usar modelos.
import { VERSION, PRESETS } from './config.js';
import { c, style, allThemes, setTheme } from './ui/theme.js';
import { loadMascots, resolveMascot, renderMascot } from './ui/mascot.js';
import * as ui from './ui/output.js';
import { select } from './ui/select.js';
import { setLanguage, L } from './i18n.js';

const API_SERVICES = [
  { id: 'gemini', label: 'Google Gemini', free: true, url: 'https://aistudio.google.com/apikey', prefer: /gemini-2\.5-flash$|gemini-.*flash/ },
  { id: 'groq', label: 'Groq', free: true, url: 'https://console.groq.com/keys', prefer: /qwen|llama-3\.3-70b/ },
  { id: 'openrouter', label: 'OpenRouter', free: true, url: 'https://openrouter.ai/keys', prefer: /:free$/ },
  { id: 'openai', label: 'OpenAI', url: 'https://platform.openai.com/api-keys', prefer: /gpt-4\.1-mini|gpt-4o-mini/ },
  { id: 'anthropic', label: 'Anthropic (Claude)', url: 'https://console.anthropic.com/settings/keys', prefer: /sonnet/ },
  { id: 'deepseek', label: 'DeepSeek', url: 'https://platform.deepseek.com/api_keys', prefer: /deepseek-chat/ },
];

function clear() {
  ui.clearScreen();
}

function header(step, total) {
  clear();
  ui.println(`${c.accent('codice', { bold: true })} ${c.dim(`v${VERSION}`)}  ${c.dim('·')}  ${c.muted(L('Configuración inicial', 'Initial setup'))} ${c.dim(`(${step}/${total})`)}`);
  ui.println('');
}

async function pickModel(runtime, input, { prefer } = {}) {
  runtime.spinner.start(L('Buscando modelos…', 'Looking for models…'));
  let models = [];
  try {
    models = await runtime.createClient({ model: 'x' }).listModels();
  } finally {
    runtime.spinner.stop();
  }
  if (!models.length) return null;
  const ordered = prefer ? [...models.filter((m) => prefer.test(m.id)), ...models.filter((m) => !prefer.test(m.id))] : models;
  const coder = ordered.findIndex((m) => /coder|code/i.test(m.id));
  return select(input, {
    title: L('Elige el modelo', 'Choose the model'),
    options: ordered.slice(0, 40).map((m) => ({ label: m.id, value: m.id, hint: m.size ? `${(m.size / 1e9).toFixed(1)} GB` : '' })),
    initial: prefer ? 0 : Math.max(0, coder),
  });
}

async function setupLocal(runtime, input) {
  const { scanModels } = await import('./local/models.js');
  const { detectBackend } = await import('./remote.js');
  runtime.spinner.start(L('Buscando modelos en tu PC…', 'Looking for models on your computer…'));
  const files = scanModels(runtime.settings);
  const server = await detectBackend();
  runtime.spinner.stop();
  // Sin servidores abiertos: directo a los modelos en archivos (o añadir carpeta / descargar).
  let how = 'files';
  if (server) {
    const serverLabel = Object.values(PRESETS).find((p) => p.baseUrl.replace(/\/+$/, '') === server.url.replace(/\/+$/, ''))?.label || server.url;
    how = await select(input, {
      title: L('¿Qué modelos quieres usar?', 'Which models do you want to use?'),
      options: [
        { label: L(`Mis modelos en archivos (${files.length})`, `My model files (${files.length})`), value: 'files', hint: L('Códice los carga solo', 'Códice loads them for you') },
        { label: L(`${serverLabel}, que ya está abierto (${server.models.length})`, `${serverLabel}, already running (${server.models.length})`), value: 'server' },
      ],
    });
    if (!how) return false;
  }
  if (how === 'server') {
    const url = server.url.replace(/\/+$/, '');
    const preset = Object.entries(PRESETS).find(([, p]) => p.baseUrl.replace(/\/+$/, '') === url)?.[0];
    runtime.save('provider', preset || 'lmstudio');
    const model = await pickModel(runtime, input);
    if (model) runtime.save('model', model);
    return Boolean(model);
  }
  const { localModelsMenu } = await import('./commands/localModels.js');
  if (!files.length) ui.hint(L('No encontré modelos todavía. Añade la carpeta donde los tienes o descarga uno de Hugging Face.', 'No models found yet. Add the folder where you keep them or download one from Hugging Face.'));
  const id = await localModelsMenu({ runtime, input });
  return Boolean(id);
}

async function setupApi(runtime, input) {
  const svc = await select(input, {
    title: L('¿Qué servicio?', 'Which provider?'),
    options: API_SERVICES.map((s) => ({ label: s.label, value: s.id, hint: s.free ? L('tiene nivel gratuito', 'has a free tier') : '', hintColor: 'status/success' })),
    footer: L('Las suscripciones de chat (Claude Pro, ChatGPT Plus) no funcionan en apps de terceros; se necesita una API key.', 'Chat subscriptions (Claude Pro, ChatGPT Plus) do not work in third-party apps; an API key is required.'),
  });
  if (!svc) return false;
  const service = API_SERVICES.find((s) => s.id === svc);
  ui.println(`${c.muted(L('Consigue tu key en', 'Get your key at'))} ${c.info(service.url)}`);
  for (let attempt = 0; attempt < 3; attempt++) {
    const key = await input.secret(`${c.accent('›', { bold: true })} ${L('Pega tu API key', 'Paste your API key')} ${c.dim(L('(no se mostrará)', '(hidden)'))}: `);
    if (!key?.trim()) return false;
    runtime.save(`providers.${svc}.apiKey`, key.trim());
    runtime.save('provider', svc);
    try {
      const model = await pickModel(runtime, input, { prefer: service.prefer });
      if (!model) return false;
      runtime.save('model', model);
      ui.success(L(`Listo: ${service.label} · ${model}`, `Done: ${service.label} · ${model}`));
      ui.hint(L('La key se guardó en ~/.codice/settings.json (solo en tu equipo).', 'The key was saved in ~/.codice/settings.json (only on your machine).'));
      return true;
    } catch (e) {
      ui.errorBox(L('La key no funcionó', 'That key did not work'), e.message, L('Revisa que esté completa y vuelve a pegarla.', 'Check it is complete and paste it again.'));
    }
  }
  return false;
}

async function setupRemote(runtime, input) {
  ui.hint(L('En tu otra PC ejecuta “codice serve”: te mostrará la dirección y el token.', 'On your other PC run “codice serve”: it shows the address and token.'));
  const url = await input.question(`${c.accent('›', { bold: true })} ${L('Dirección (ej. http://192.168.1.50:8787)', 'Address (e.g. http://192.168.1.50:8787)')}: `);
  if (!url?.trim()) return false;
  const token = await input.secret(`${c.accent('›', { bold: true })} Token: `);
  if (!token?.trim()) return false;
  const { connect } = await import('./remote.js');
  const code = await connect([url.trim()], { token: token.trim(), name: 'pc-remota' }, runtime);
  return code === 0;
}

export async function runOnboarding(runtime, input) {
  // durante el asistente no se muestra la caja de escritura ni la barra de estado (no abrumar)
  input?.setHidden?.(true);
  try {
    return await onboardingSteps(runtime, input);
  } finally {
    input?.setHidden?.(false);
  }
}

async function onboardingSteps(runtime, input) {
  // 1. Idioma
  header(1, 3);
  const lang = await select(input, {
    title: 'Elige tu idioma · Choose your language',
    options: [{ label: 'Español', value: 'es' }, { label: 'English', value: 'en' }],
    initial: runtime.settings.language === 'en' ? 1 : 0,
    footer: '↑↓ · enter',
    collapse: false,
    erase: true,
  });
  if (lang) { setLanguage(lang); runtime.save('language', lang); }

  // 2. Tema (con la mascota de cada tema)
  header(2, 3);
  const themes = allThemes(runtime.settings.customThemes);
  const mascots = loadMascots();
  const ids = ['auto', ...Object.keys(themes)];
  const current = runtime.settings.theme || 'auto';
  const theme = await select(input, {
    title: L('Elige un tema', 'Choose a theme'),
    options: ids.map((id) => ({ label: id === 'auto' ? L('Automático (según tu terminal)', 'Automatic (match your terminal)') : themes[id].name, value: id })),
    initial: Math.max(0, ids.indexOf(current)),
    onChange: (opt) => setTheme(opt.value, runtime.settings.customThemes),
    extra: (opt) => {
      setTheme(opt.value, runtime.settings.customThemes);
      const pet = resolveMascot({ ...runtime.settings, theme: opt.value, mascot: { name: 'auto' } }, mascots);
      return [
        '',
        ...renderMascot(pet).map((l) => `  ${l}`),
        '',
        `  ${c.accent('›', { bold: true })} ${c.primary(L('arregla el bug del login', 'fix the login bug'))}`,
        `  ${c.success('●', { bold: true })} ${style('Edit', { bold: true, fg: 'text/primary' })}${c.muted('(src/auth.ts)')}  ${c.dim(L('└ 1 cambio', '└ 1 change'))}`,
        `  ${style('- if (user = null)   ', { fg: 'text/primary', bg: 'diff/del-bg' })}  ${style('+ if (user === null) ', { fg: 'text/primary', bg: 'diff/add-bg' })}`,
        '',
      ];
    },
    footer: L('↑↓ elegir · enter confirmar · podrás cambiarlo con /theme', '↑↓ move · enter select · change it later with /theme'),
    collapse: false,
    erase: true,
  });
  if (theme) runtime.save('theme', theme);
  else setTheme(current, runtime.settings.customThemes);

  // 3. Cómo usar modelos
  header(3, 3);
  const how = await select(input, {
    title: L('¿Cómo quieres usar los modelos?', 'How do you want to run models?'),
    options: [
      { label: L('Modelo local en esta PC', 'Local model on this computer'), value: 'local', hint: L('tus archivos GGUF, Ollama, LM Studio…', 'your GGUF files, Ollama, LM Studio…') },
      { label: L('API key de un servicio', 'API key from a provider'), value: 'api', hint: 'Gemini, Groq, OpenRouter, OpenAI, Anthropic…' },
      { label: L('Mi otra PC con “codice serve”', 'My other PC running “codice serve”'), value: 'remote' },
      { label: L('Configurar después', 'Set up later'), value: 'later' },
    ],
    collapse: false,
    erase: true,
  });
  let ok = false;
  if (how === 'local') ok = await setupLocal(runtime, input);
  else if (how === 'api') ok = await setupApi(runtime, input);
  else if (how === 'remote') ok = await setupRemote(runtime, input);
  runtime.save('onboarded', true);
  ui.clearScreen({ bottom: true }); // la caja de escritura vuelve, pegada al fondo
  if (!ok) ui.hint(L('Puedes configurar el modelo cuando quieras con /setup.', 'You can set up a model anytime with /setup.'));
  return ok;
}
