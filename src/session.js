// Sesiones guardadas en ~/.codice/sessions/<id>.json y checkpoints de archivos para /rewind.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './config.js';
import { readJSON, writeJSON, randomId } from './util/fs.js';

const DIR = () => path.join(HOME, 'sessions');

export class Session {
  constructor({ id, cwd, messages = [], created, title = '', model = '' } = {}) {
    this.id = id || `${new Date().toISOString().slice(0, 10)}-${randomId(6)}`;
    this.cwd = cwd;
    this.messages = messages;
    this.created = created || Date.now();
    this.title = title;
    this.model = model;
  }

  save() {
    if (!this.messages.length) return;
    if (!this.title) {
      const first = this.messages.find((m) => m.role === 'user' && typeof m.content === 'string');
      this.title = first ? first.content.replace(/\s+/g, ' ').slice(0, 80) : '';
    }
    writeJSON(path.join(DIR(), `${this.id}.json`), {
      id: this.id, cwd: this.cwd, created: this.created, updated: Date.now(), title: this.title, model: this.model, messages: this.messages,
    });
  }

  static load(id) {
    const data = readJSON(path.join(DIR(), `${id}.json`));
    return data ? new Session(data) : null;
  }

  static list(cwd, limit = 20) {
    let files = [];
    try { files = fs.readdirSync(DIR()).filter((f) => f.endsWith('.json')); } catch { return []; }
    return files
      .map((f) => {
        try {
          const st = fs.statSync(path.join(DIR(), f));
          return { file: f, mtime: st.mtimeMs };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .map(({ file }) => readJSON(path.join(DIR(), file)))
      .filter((s) => s && (!cwd || path.resolve(s.cwd || '') === path.resolve(cwd)))
      .slice(0, limit)
      .map((s) => ({ id: s.id, title: s.title, updated: s.updated, model: s.model, count: s.messages?.length || 0 }));
  }

  static latest(cwd) {
    const [s] = Session.list(cwd, 1);
    return s ? Session.load(s.id) : null;
  }
}

// Guarda el contenido original de cada archivo antes del primer cambio de cada turno.
export class Checkpoints {
  constructor() {
    this.turns = []; // [{ messageIndex, prompt, files: Map<path, string|null>, time }]
  }

  beginTurn(messageIndex, prompt) {
    this.turns.push({ messageIndex, prompt: String(prompt).slice(0, 100), files: new Map(), time: Date.now() });
  }

  snapshot(file) {
    const turn = this.turns.at(-1);
    if (!turn || turn.files.has(file)) return;
    turn.files.set(file, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  }

  list() {
    return this.turns.map((t, i) => ({ index: i, prompt: t.prompt, files: t.files.size, time: t.time, messageIndex: t.messageIndex }));
  }

  // Restaura los archivos al estado anterior al turno `index` y devuelve el índice de mensaje para recortar.
  rewind(index, { restoreFiles = true } = {}) {
    const restored = [];
    if (restoreFiles) {
      for (let i = this.turns.length - 1; i >= index; i--) {
        for (const [file, content] of this.turns[i].files) {
          if (content === null) { try { fs.unlinkSync(file); } catch { /* ya no existe */ } }
          else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
          restored.push(file);
        }
      }
    }
    const messageIndex = this.turns[index]?.messageIndex ?? 0;
    this.turns = this.turns.slice(0, index);
    return { restored: [...new Set(restored)], messageIndex };
  }
}
