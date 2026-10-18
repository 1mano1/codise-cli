// Rutas, valores por defecto, proveedores predefinidos y carga/guardado de settings.json.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readJSON, writeJSON, setDeep, findUp } from './util/fs.js';

export const APP_NAME = 'Códice';
export const APP_CMD = 'codice';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOME = process.env.CODICE_HOME || path.join(os.homedir(), '.codice');
export const VERSION = readJSON(path.join(ROOT, 'package.json'), {}).version || '0.0.0';

// Proveedores conocidos. type: "ollama" (API nativa), "openai" (compatible) o "codice" (codice serve remoto).
export const PRESETS = {
  local: { type: 'local', baseUrl: 'local', label: 'Modelos locales (GGUF)' },
  ollama: { type: 'ollama', baseUrl: 'http://localhost:11434', label: 'Ollama' },
  lmstudio: { type: 'openai', baseUrl: 'http://localhost:1234/v1', label: 'LM Studio' },
  llamacpp: { type: 'openai', baseUrl: 'http://localhost:8080/v1', label: 'llama.cpp' },
  vllm: { type: 'openai', baseUrl: 'http://localhost:8000/v1', label: 'vLLM' },
  jan: { type: 'openai', baseUrl: 'http://localhost:1337/v1', label: 'Jan' },
  openrouter: { type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', label: 'OpenRouter', cloud: true },
  openai: { type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', label: 'OpenAI', cloud: true },
  groq: { type: 'openai', baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY', label: 'Groq', cloud: true },
  deepseek: { type: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', label: 'DeepSeek', cloud: true },
  anthropic: { type: 'openai', baseUrl: 'https://api.anthropic.com/v1', apiKeyEnv: 'ANTHROPIC_API_KEY', label: 'Anthropic', cloud: true },
  gemini: { type: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyEnv: 'GEMINI_API_KEY', label: 'Gemini', cloud: true },
};

export const DEFAULTS = {
  provider: 'local',
  model: '',
  modelDirs: [],
  local: { gpuLayers: 99, serverPath: '', threads: 0 },
  providers: {},
  fallback: [],
  toolMode: 'auto',
  contextWindow: 16384,
  temperature: 0.2,
  maxTurns: 80,
  maxOutputTokens: 0,
  permissions: { mode: 'default', allow: [], deny: [] },
  theme: 'auto',
  customThemes: {},
  mascot: { name: 'auto', animated: true },
  themeMascots: {},
  language: 'es',
  onboarded: false,
  spinnerVerbs: [],
  outputStyle: 'normal',
  showThinking: true,
  statusLine: {},
  accessibility: { screenReader: false, reduceMotion: false, noColor: false },
  autoCompact: 0.85,
  notifications: false,
  offline: false,
  lean: false,
  mcpServers: {},
  hooks: {},
  enabledPlugins: {},
  compat: { claude: true },
  agentModels: {},
};

const CONCAT_KEYS = new Set(['allow', 'deny']);

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, over) {
  if (!isPlainObject(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else if (Array.isArray(v) && Array.isArray(out[k]) && CONCAT_KEYS.has(k)) out[k] = [...new Set([...out[k], ...v])];
    else out[k] = v;
  }
  return out;
}

export function findProjectRoot(cwd) {
  return findUp(cwd, ['.codice', '.git']) || cwd;
}

export function settingsFiles(projectRoot) {
  return {
    user: path.join(HOME, 'settings.json'),
    project: path.join(projectRoot, '.codice', 'settings.json'),
    local: path.join(projectRoot, '.codice', 'settings.local.json'),
  };
}

export function loadSettings(projectRoot) {
  const files = settingsFiles(projectRoot);
  let s = structuredClone(DEFAULTS);
  for (const f of [files.user, files.project, files.local]) s = deepMerge(s, readJSON(f, {}));
  return s;
}

export function saveSetting(projectRoot, scope, keyPath, value) {
  const file = settingsFiles(projectRoot)[scope] || settingsFiles(projectRoot).user;
  const data = readJSON(file, {});
  setDeep(data, keyPath, value);
  writeJSON(file, data);
  return file;
}

export function ensureHome() {
  for (const d of ['', 'agents', 'skills', 'commands', 'plugins', 'mascots', 'sessions', 'checkpoints']) {
    fs.mkdirSync(path.join(HOME, d), { recursive: true });
  }
}

// Resuelve la configuración completa de un proveedor por nombre.
export function resolveProvider(settings, name) {
  const custom = settings.providers?.[name] || {};
  const preset = PRESETS[name] || {};
  const merged = { ...preset, ...custom, name };
  if (!merged.type) merged.type = 'openai';
  if (!merged.baseUrl) return null;
  if (!merged.apiKey && merged.apiKeyEnv) merged.apiKey = process.env[merged.apiKeyEnv] || '';
  return merged;
}

export function listProviderNames(settings) {
  return [...new Set([...Object.keys(PRESETS), ...Object.keys(settings.providers || {})])];
}
