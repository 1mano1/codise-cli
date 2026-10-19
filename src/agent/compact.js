// Compactación del contexto: resume la conversación cuando se acerca al límite del modelo.
import { stripThinking } from '../llm/stream.js';
import { estimateTokens } from '../util/fs.js';

export function estimateContext(systemPrompt, messages) {
  let n = estimateTokens(systemPrompt);
  for (const m of messages) {
    n += estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) + 4;
    if (m.tool_calls) n += estimateTokens(JSON.stringify(m.tool_calls));
  }
  return n;
}

function entry(m) {
  if (m.role === 'tool') return `[result of ${m.name}]\n${String(m.content).slice(0, 1500)}`;
  const calls = m.tool_calls?.map((tc) => `[calls ${tc.function.name} ${String(tc.function.arguments).slice(0, 300)}]`).join('\n') || '';
  return `[${m.role}]\n${String(m.content || '').slice(0, 6000)}${calls ? `\n${calls}` : ''}`;
}

// Transcripción que cabe en `budget` tokens: conserva el primer mensaje y lo más reciente.
export function transcript(messages, budget = Infinity) {
  const parts = messages.map(entry);
  let total = parts.reduce((n, p) => n + estimateTokens(p), 0);
  if (total <= budget) return parts.join('\n\n');
  const first = parts[0];
  const rest = parts.slice(1);
  let dropped = 0;
  total -= estimateTokens(first);
  while (rest.length > 1 && total > budget - estimateTokens(first) - 20) {
    total -= estimateTokens(rest.shift());
    dropped++;
  }
  return [first, `[… ${dropped} older messages omitted …]`, ...rest].join('\n\n');
}

export const SUMMARY_PROMPT = `Your task is to summarize the coding session below so the work can continue with no other context.
Write these sections, in the same language the user used:
1. Primary request and intent: everything the user asked for, in detail.
2. Key technical concepts: technologies, frameworks and conventions involved.
3. Files and code: files read, created or changed (full paths), why they matter and the essential snippets.
4. Errors and fixes: problems found and how they were solved, including user corrections.
5. Pending tasks: what the user asked for that is not done yet.
6. Current work: exactly what was being done right before this summary.
7. Next step: the next action, consistent with the user's latest request. Quote the latest request verbatim.
Be precise and dense. Do not invent anything that is not in the session.`;

export async function summarize(client, messages, { instructions = '', signal, budget = Infinity, maxTokens = 0 } = {}) {
  // el resumen DEBE ser más corto que la conversación o la compactación no libera espacio y se repite cada turno
  const words = maxTokens ? Math.max(150, Math.round(maxTokens / 1.3)) : 0;
  const limit = words ? `\n\nHard limit: write the whole summary in at most ${words} words. Be terse — keep only what is needed to continue; drop routine command output, repeated attempts and dead ends. If you run long, you lose context, so stay well under the limit.` : '';
  const prompt = `${SUMMARY_PROMPT}${instructions ? `\nAdditional instructions: ${instructions}` : ''}${limit}

<session>
${transcript(messages, budget)}
</session>`;
  const r = await client.chat({
    messages: [
      { role: 'system', content: 'You write precise, dense summaries of software engineering sessions. You are concise and never exceed the requested length.' },
      { role: 'user', content: prompt },
    ],
    signal,
    maxTokens: maxTokens || undefined, // techo duro para que no genere un resumen enorme
  });
  return stripThinking(r.content);
}

// Índice desde el que se conservan mensajes: el último mensaje de usuario "normal" (no resultado de herramienta).
export function keepFromIndex(messages) {
  for (let i = messages.length - 1; i > 0; i--) {
    if (messages[i].role === 'user') return i;
  }
  return messages.length;
}
