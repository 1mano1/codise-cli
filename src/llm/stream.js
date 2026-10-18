// Lectura de respuestas en streaming: SSE (OpenAI) y NDJSON (Ollama).

export async function* lines(body) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
    }
  }
  buf += dec.decode();
  if (buf) yield buf;
}

export async function* sse(body) {
  for await (const line of lines(body)) {
    if (line.startsWith('data:')) yield line.slice(5).trimStart();
  }
}

export async function* ndjson(body) {
  for await (const line of lines(body)) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch { /* línea parcial o inválida */ }
  }
}

// Separa <think>…</think> (razonamiento) y oculta <tool_call>…</tool_call> mientras llega el texto.
const TAGS = { think: 'reasoning', thinking: 'reasoning', tool_call: 'hidden' };

function partialSuffix(buf, tags) {
  let max = 0;
  for (const t of tags) {
    for (let k = Math.min(t.length - 1, buf.length); k > 0; k--) {
      if (buf.endsWith(t.slice(0, k))) { max = Math.max(max, k); break; }
    }
  }
  return max;
}

export class TagSplitter {
  constructor({ onText, onReasoning }) {
    this.onText = onText;
    this.onReasoning = onReasoning;
    this.buf = '';
    this.state = null;
    this.sawText = false;
  }

  push(chunk) {
    this.buf += chunk;
    this.process(false);
  }

  flush() {
    this.process(true);
  }

  emit(kind, s) {
    if (!s) return;
    if (kind === 'text') {
      if (!s.trim() && !this.sawText) return;
      this.sawText = true;
      this.onText?.(s);
    } else if (kind === 'reasoning') this.onReasoning?.(s);
  }

  process(final) {
    while (this.buf) {
      if (!this.state) {
        let best = -1, tag = null;
        for (const t of Object.keys(TAGS)) {
          const i = this.buf.indexOf(`<${t}>`);
          if (i >= 0 && (best < 0 || i < best)) { best = i; tag = t; }
        }
        // cierre huérfano de razonamiento: lo previo era pensamiento
        const orphan = this.buf.indexOf('</think>');
        if (orphan >= 0 && (best < 0 || orphan < best) && !this.sawText) {
          this.emit('reasoning', this.buf.slice(0, orphan));
          this.buf = this.buf.slice(orphan + 8);
          continue;
        }
        if (best < 0) {
          const keep = final ? 0 : partialSuffix(this.buf, [...Object.keys(TAGS).map((t) => `<${t}>`), '</think>']);
          this.emit('text', this.buf.slice(0, this.buf.length - keep));
          this.buf = this.buf.slice(this.buf.length - keep);
          return;
        }
        this.emit('text', this.buf.slice(0, best));
        this.buf = this.buf.slice(best + tag.length + 2);
        this.state = tag;
      } else {
        const close = `</${this.state}>`;
        const i = this.buf.indexOf(close);
        const kind = TAGS[this.state];
        if (i < 0) {
          const keep = final ? 0 : partialSuffix(this.buf, [close]);
          this.emit(kind, this.buf.slice(0, this.buf.length - keep));
          this.buf = this.buf.slice(this.buf.length - keep);
          return;
        }
        this.emit(kind, this.buf.slice(0, i));
        this.buf = this.buf.slice(i + close.length);
        this.state = null;
      }
    }
  }
}

export function stripThinking(text) {
  let t = String(text ?? '');
  if (t.includes('</think>') && !t.includes('<think>')) t = t.slice(t.indexOf('</think>') + 8);
  return t.replace(/<think(?:ing)?>[\s\S]*?(?:<\/think(?:ing)?>|$)/g, '').trim();
}
