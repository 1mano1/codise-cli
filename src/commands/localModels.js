// Gestión de modelos locales desde Códice: elegir, añadir carpetas, descargar de Hugging Face y el motor.
import fs from 'node:fs';
import path from 'node:path';
import { c } from '../ui/theme.js';
import * as ui from '../ui/output.js';
import { select, confirm } from '../ui/select.js';
import { scanModels, unsupportedModels, modelDirs } from '../local/models.js';
import { findEngines, installEngine, LLAMA_VERSION } from '../local/engine.js';
import { listGgufFiles, downloadGguf, parseRepo } from '../local/hf.js';
import { resolvePath } from '../util/fs.js';
import { L } from '../i18n.js';

const gb = (b) => `${(b / 1e9).toFixed(b < 1e9 ? 2 : 1)} GB`;
const SOURCE = { ollama: 'Ollama', huggingface: 'Hugging Face', lmstudio: 'LM Studio', gguf: 'GGUF' };

function progress(runtime, label) {
  let last = 0;
  return (done, total) => {
    if (Date.now() - last < 250) return;
    last = Date.now();
    const pct = total ? Math.floor((done / total) * 100) : 0;
    runtime.spinner.setVerb(`${label} ${pct}% · ${gb(done)}${total ? ` / ${gb(total)}` : ''}`);
  };
}

// Se asegura de tener llama.cpp; si falta, ofrece descargarlo.
export async function ensureEngine({ runtime, input }) {
  if (findEngines(runtime.settings).length) return true;
  ui.println(c.primary(L('Para usar modelos GGUF, Códice necesita el motor llama.cpp (unos 30 MB, solo una vez).', 'To run GGUF models, Códice needs the llama.cpp engine (about 30 MB, only once).')));
  if (input && !(await confirm(input, L('¿Descargarlo ahora?', 'Download it now?')))) return false;
  runtime.spinner.start(L('Descargando el motor…', 'Downloading the engine…'));
  try {
    const onProgress = progress(runtime, L('Descargando el motor', 'Downloading the engine'));
    const got = await installEngine({ onProgress: (variant, d, t) => onProgress(d, t) });
    runtime.spinner.stop();
    ui.success(L(`Motor listo: llama.cpp ${LLAMA_VERSION} (${got.map((g) => g.variant).join(' + ')})`, `Engine ready: llama.cpp ${LLAMA_VERSION} (${got.map((g) => g.variant).join(' + ')})`));
    return true;
  } catch (e) {
    runtime.spinner.stop();
    ui.errorBox(L('No se pudo descargar el motor', 'Could not download the engine'), e.message, L('Revisa tu conexión a internet e inténtalo de nuevo con /models.', 'Check your internet connection and try again with /models.'));
    return false;
  }
}

export function addModelDir(runtime, dir) {
  const p = resolvePath(dir.replace(/^"|"$/g, ''), runtime.cwd);
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
    ui.warn(L(`No existe la carpeta: ${p}`, `Folder not found: ${p}`));
    return false;
  }
  runtime.save('modelDirs', [...new Set([...(runtime.settings.modelDirs || []), p])]);
  const n = scanModels(runtime.settings).filter((m) => m.file.toLowerCase().startsWith(p.toLowerCase())).length;
  ui.success(L(`Carpeta añadida: ${p} · ${n} modelo${n === 1 ? '' : 's'}`, `Folder added: ${p} · ${n} model${n === 1 ? '' : 's'}`));
  return true;
}

export async function downloadFromHF({ runtime, input }, repoArg) {
  let repo = parseRepo(repoArg);
  if (!repo && input) {
    ui.hint(L('Ejemplos: Imanol11/qwen3b-int4-Octuma · Qwen/Qwen2.5-Coder-7B-Instruct-GGUF', 'Examples: Imanol11/qwen3b-int4-Octuma · Qwen/Qwen2.5-Coder-7B-Instruct-GGUF'));
    repo = parseRepo(await input.question(`${c.accent('›', { bold: true })} ${L('Repositorio de Hugging Face (usuario/modelo)', 'Hugging Face repository (user/model)')}: `));
  }
  if (!repo) { ui.warn(L('Repositorio no válido. Formato: usuario/modelo', 'Invalid repository. Format: user/model')); return null; }
  runtime.spinner.start(L('Consultando Hugging Face…', 'Checking Hugging Face…'));
  let files;
  try { files = await listGgufFiles(repo); } catch (e) { runtime.spinner.stop(); ui.errorBox(L('No se pudo consultar el repositorio', 'Could not read the repository'), e.message); return null; }
  runtime.spinner.stop();
  if (!files.length) { ui.warn(L(`${repo} no tiene archivos GGUF. Busca la versión "-GGUF" del modelo.`, `${repo} has no GGUF files. Look for the "-GGUF" version of the model.`)); return null; }
  // por defecto, la cuantización equilibrada (Q4_K_M) o la más pequeña razonable
  const preferred = Math.max(0, files.findIndex((f) => /q4_k_m/i.test(f.path)));
  const file = files.length === 1 ? files[0] : await select(input, {
    title: L(`Archivos GGUF en ${repo}`, `GGUF files in ${repo}`),
    options: files.map((f) => ({ label: f.path, value: f, hint: gb(f.size) })),
    initial: preferred,
  });
  if (!file) return null;
  runtime.spinner.start(L('Descargando…', 'Downloading…'));
  try {
    const dest = await downloadGguf(repo, file, { onProgress: progress(runtime, L('Descargando', 'Downloading')) });
    runtime.spinner.stop();
    ui.success(L(`Descargado y verificado: ${dest}`, `Downloaded and verified: ${dest}`));
    const model = scanModels(runtime.settings).find((m) => m.file === dest);
    return model?.id || null;
  } catch (e) {
    runtime.spinner.stop();
    ui.errorBox(L('La descarga falló', 'The download failed'), e.message);
    return null;
  }
}

// Menú de modelos locales. Devuelve el id elegido (y lo deja activo) o null.
export async function localModelsMenu(ctx) {
  const { runtime, repl } = ctx;
  const input = repl?.input || ctx.input;
  for (;;) {
    const models = scanModels(runtime.settings);
    const current = runtime.settings.provider === 'local' ? runtime.settings.model : null;
    const options = models.map((m) => ({
      label: m.id,
      value: { model: m },
      hint: [gb(m.size), SOURCE[m.source] || '', m.id === current ? L('actual', 'current') : ''].filter(Boolean).join(' · '),
      hintColor: m.id === current ? 'status/success' : 'text/dim',
    }));
    options.push({ label: c.accent(L('+ Añadir una carpeta con modelos…', '+ Add a folder with models…')), value: { action: 'dir' } });
    options.push({ label: c.accent(L('↓ Descargar un modelo de Hugging Face…', '↓ Download a model from Hugging Face…')), value: { action: 'hf' } });
    const unsupported = unsupportedModels(runtime.settings);
    const footer = unsupported.length
      ? L(`${unsupported.length} modelo(s) en formato no compatible (safetensors/ONNX): busca su versión GGUF.`, `${unsupported.length} model(s) in an unsupported format (safetensors/ONNX): look for their GGUF version.`)
      : L('↑↓ elegir · enter usar · esc salir', '↑↓ move · enter use · esc exit');
    const title = models.length
      ? L(`Modelos locales (${models.length})`, `Local models (${models.length})`)
      : L('No encontré modelos GGUF todavía', 'No GGUF models found yet');
    const choice = await select(input, { title, options, initial: Math.max(0, models.findIndex((m) => m.id === current)), footer });
    if (!choice) return null;
    if (choice.action === 'dir') {
      ui.hint(`${L('Busco en', 'Searching in')}: ${modelDirs(runtime.settings).join(' · ')}`);
      const dir = await input.question(`${c.accent('›', { bold: true })} ${L('Ruta de la carpeta', 'Folder path')}: `);
      if (dir?.trim()) addModelDir(runtime, dir.trim());
      continue;
    }
    if (choice.action === 'hf') {
      const id = await downloadFromHF({ runtime, input });
      if (!id) continue;
      return activate(ctx, id);
    }
    return activate(ctx, choice.model.id);
  }
}

async function activate(ctx, id) {
  const { runtime } = ctx;
  if (!(await ensureEngine({ runtime, input: ctx.repl?.input || ctx.input }))) return null;
  runtime.save('provider', 'local');
  runtime.save('model', id);
  ui.success(L(`Modelo: ${id} (se carga al enviar el primer mensaje)`, `Model: ${id} (loads when you send the first message)`));
  return id;
}

// Subcomandos: /models add-dir <ruta> · /models dirs · /models download <repo>
export async function localModelsCommand(args, ctx) {
  const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const arg = rest.join(' ');
  if (sub === 'add-dir' && arg) return addModelDir(ctx.runtime, arg);
  if (sub === 'remove-dir' && arg) {
    ctx.runtime.save('modelDirs', (ctx.runtime.settings.modelDirs || []).filter((d) => d.toLowerCase() !== path.resolve(arg).toLowerCase()));
    return ui.success(L('Carpeta quitada.', 'Folder removed.'));
  }
  if (sub === 'dirs') {
    for (const d of modelDirs(ctx.runtime.settings)) ui.println(`  ${c.info(d)}`);
    return null;
  }
  if (sub === 'download') {
    const id = await downloadFromHF({ runtime: ctx.runtime, input: ctx.repl?.input }, arg);
    return id ? activate(ctx, id) : null;
  }
  return localModelsMenu(ctx);
}
