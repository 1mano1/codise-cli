// Modelos locales en archivos .gguf: carpetas donde buscarlos y detección.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HOME } from '../config.js';

export function modelsHome() {
  return path.join(HOME, 'models');
}

// Carpetas donde se buscan modelos: la de Códice, las que elija el usuario y las habituales de otras apps.
export function modelDirs(settings) {
  const h = os.homedir();
  const dirs = [
    modelsHome(),
    ...(settings.modelDirs || []),
    path.join(h, '.cache', 'huggingface', 'hub'),
    path.join(h, '.cache', 'lm-studio', 'models'),
    path.join(h, '.lmstudio', 'models'),
    path.join(h, 'jan', 'models'),
  ];
  const seen = new Set();
  return dirs.map((d) => path.resolve(d)).filter((d) => {
    const k = d.toLowerCase();
    if (seen.has(k) || !fs.existsSync(d)) return false;
    seen.add(k);
    return true;
  });
}

function* walk(dir, depth) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    let isDir = e.isDirectory(), isFile = e.isFile();
    if (e.isSymbolicLink()) {
      try { const st = fs.statSync(p); isDir = st.isDirectory(); isFile = st.isFile(); } catch { continue; }
    }
    if (isDir && depth > 0 && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'blobs') yield* walk(p, depth - 1);
    else if (isFile) yield p;
  }
}

// Nombre corto y legible: en la caché de Hugging Face usa "repo/archivo".
function modelId(file) {
  const base = path.basename(file).replace(/\.gguf$/i, '');
  const m = file.replace(/\\/g, '/').match(/models--[^/]+--([^/]+)\/snapshots\//);
  return m && !base.toLowerCase().includes(m[1].toLowerCase().slice(0, 6)) ? `${m[1]}/${base}` : base;
}

// Modelos descargados con Ollama: por dentro son GGUF (manifiesto → blob). Se pueden usar aunque Ollama esté apagado.
export function ollamaModels() {
  const root = process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama', 'models');
  const manifests = path.join(root, 'manifests');
  const out = [];
  const visit = (dir, parts) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) visit(p, [...parts, e.name]);
      else if (e.isFile()) {
        try {
          const man = JSON.parse(fs.readFileSync(p, 'utf8'));
          const layer = (man.layers || []).find((l) => l.mediaType === 'application/vnd.ollama.image.model');
          if (!layer) continue;
          const file = path.join(root, 'blobs', layer.digest.replace(':', '-'));
          if (!fs.existsSync(file)) continue;
          // parts: [registro, namespace, modelo] → nombre:etiqueta como en Ollama
          const name = parts.slice(-1)[0];
          const ns = parts.slice(-2)[0];
          out.push({ id: `${ns === 'library' ? '' : `${ns}/`}${name}:${e.name}`, file, size: layer.size || fs.statSync(file).size, dir: root, source: 'ollama' });
        } catch { /* manifiesto ilegible */ }
      }
    }
  };
  visit(manifests, []);
  return out;
}

// Modelos que existen en disco pero en formatos que llama.cpp no abre directamente.
export function unsupportedModels(settings) {
  const out = [];
  const seen = new Set();
  for (const dir of modelDirs(settings)) {
    for (const file of walk(dir, 6)) {
      const name = path.basename(file);
      let kind = null;
      if (/\.safetensors$/i.test(name) || /^pytorch_model.*\.bin$/i.test(name)) kind = 'safetensors';
      else if (/\.onnx$/i.test(name)) kind = 'onnx';
      else if (/\.mlx|mlx/i.test(name) && /\.npz|\.safetensors/.test(name)) kind = 'mlx';
      if (!kind) continue;
      const m = file.replace(/\\/g, '/').match(/models--([^/]+)--([^/]+)\//);
      const id = m ? `${m[1]}/${m[2]}` : path.basename(path.dirname(file));
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, kind, dir: path.dirname(file) });
    }
  }
  return out;
}

export function scanModels(settings) {
  const out = [];
  const ids = new Set();
  for (const m of ollamaModels()) { ids.add(m.id); out.push(m); }
  for (const dir of modelDirs(settings)) {
    for (const file of walk(dir, 6)) {
      if (!/\.gguf$/i.test(file) || /mmproj|vocab/i.test(path.basename(file))) continue;
      let size = 0;
      try { size = fs.statSync(file).size; } catch { continue; }
      if (size < 20 * 1024 * 1024) continue;
      // modelos divididos: solo la primera parte
      if (/-0000[2-9]-of-|-000[1-9]\d-of-/.test(file)) continue;
      let id = modelId(file);
      if (ids.has(id)) id = `${id} (${path.basename(path.dirname(file))})`;
      ids.add(id);
      out.push({ id, file, size, dir, source: dir.includes('huggingface') ? 'huggingface' : dir.includes('lm-studio') || dir.includes('lmstudio') ? 'lmstudio' : 'gguf' });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function resolveModelFile(settings, id) {
  if (!id) return null;
  if (/\.gguf$/i.test(id) && fs.existsSync(id)) return { id: modelId(id), file: id, size: fs.statSync(id).size };
  return scanModels(settings).find((m) => m.id === id || m.file === id) || null;
}
