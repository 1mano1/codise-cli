// Descarga de modelos GGUF desde Hugging Face.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { modelsHome } from './models.js';
import { L } from '../i18n.js';

function headers() {
  const token = process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function parseRepo(input) {
  const s = String(input || '').trim().replace(/^https?:\/\/huggingface\.co\//, '').replace(/\/(tree|blob|resolve)\/.*$/, '').replace(/\/$/, '');
  return /^[\w.-]+\/[\w.-]+$/.test(s) ? s : null;
}

export async function listGgufFiles(repo) {
  const res = await fetch(`https://huggingface.co/api/models/${repo}/tree/main?recursive=1`, { headers: headers() });
  if (res.status === 401 || res.status === 404) throw new Error(L(`No encontré el repositorio "${repo}" (¿nombre correcto? ¿es privado? usa HF_TOKEN)`, `Repository "${repo}" not found (correct name? private? set HF_TOKEN)`));
  if (!res.ok) throw new Error(`Hugging Face HTTP ${res.status}`);
  const files = await res.json();
  return files
    .filter((f) => f.type === 'file' && /\.gguf$/i.test(f.path) && !/mmproj/i.test(f.path))
    .map((f) => ({ path: f.path, size: f.lfs?.size || f.size, sha256: f.lfs?.oid || null }));
}

// Descarga a ~/.codice/models/<usuario>__<repo>/<archivo>, verificando el SHA-256 cuando está disponible.
export async function downloadGguf(repo, file, { onProgress, signal } = {}) {
  const dir = path.join(modelsHome(), repo.replace('/', '__'));
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(file.path));
  if (fs.existsSync(dest) && fs.statSync(dest).size === file.size) return dest;
  const part = `${dest}.part`;
  const res = await fetch(`https://huggingface.co/${repo}/resolve/main/${file.path}`, { headers: headers(), redirect: 'follow', signal });
  if (!res.ok) throw new Error(`Hugging Face HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || file.size || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(part);
  let done = 0;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      done += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      onProgress?.(done, total);
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  } catch (e) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw e;
  }
  if (file.sha256 && hash.digest('hex') !== file.sha256) {
    fs.rmSync(part, { force: true });
    throw new Error(L('El archivo descargado está dañado (SHA-256 no coincide). Intenta de nuevo.', 'The downloaded file is corrupted (SHA-256 mismatch). Try again.'));
  }
  fs.renameSync(part, dest);
  return dest;
}
