// Historial de la conversación: valida y repara las llamadas a herramientas antes de guardarlas o reenviarlas.
// Una llamada con argumentos JSON inválidos (p. ej. cortada por un bucle o por el límite de tokens) rompe la
// conversación para siempre: servidores como llama-server responden 500 en cada petición que la incluya.

// ¿Los argumentos son un objeto JSON válido? (vacío cuenta como {})
export function validArgs(raw) {
  if (raw && typeof raw === 'object') return !Array.isArray(raw);
  const s = String(raw ?? '').trim();
  if (!s) return true;
  try {
    const v = JSON.parse(s);
    return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  } catch {
    return false;
  }
}

export const brokenNote = (name) => `[tool call ${name || 'unknown'} omitted: its arguments were invalid JSON, probably cut off]`;

// Repara el historial sin perder el contexto: cada llamada rota se sustituye por una nota en el texto del
// asistente y se quitan sus resultados; también se quitan resultados huérfanos (sin llamada que los pida).
// Devuelve { messages, fixed } (fixed = cuántas llamadas se repararon).
export function sanitizeHistory(messages = []) {
  const out = [];
  const known = new Set();
  let fixed = 0;
  for (const m of messages) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const good = m.tool_calls.filter((tc) => validArgs(tc?.function?.arguments));
      const bad = m.tool_calls.filter((tc) => !validArgs(tc?.function?.arguments));
      if (!bad.length) {
        for (const tc of good) known.add(tc.id);
        out.push(m);
        continue;
      }
      fixed += bad.length;
      const copy = { ...m, content: [m.content, ...bad.map((tc) => brokenNote(tc?.function?.name))].filter(Boolean).join('\n') };
      if (good.length) { copy.tool_calls = good; for (const tc of good) known.add(tc.id); } else delete copy.tool_calls;
      out.push(copy);
      continue;
    }
    // resultado de una llamada que ya no existe: los servidores lo rechazan
    if (m?.role === 'tool' && m.tool_call_id && !known.has(m.tool_call_id)) continue;
    out.push(m);
  }
  return { messages: out, fixed };
}
