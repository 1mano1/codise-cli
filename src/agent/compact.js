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

function transcript(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') return `[resultado de ${m.name}]\n${String(m.content).slice(0, 1500)}`;
    const calls = m.tool_calls?.map((tc) => `[llama a ${tc.function.name} ${tc.function.arguments.slice(0, 300)}]`).join('\n') || '';
    return `[${m.role}]\n${String(m.content || '').slice(0, 6000)}${calls ? `\n${calls}` : ''}`;
  }).join('\n\n');
}

export async function summarize(client, messages, { instructions = '', signal } = {}) {
  const prompt = `Summarize the following coding session so it can be continued with no other context.
Include: the user's goals and requests, key decisions, files read or changed (with paths), commands run and their outcome, errors found, the current state and the exact next steps. Keep code snippets only when essential. Write in the same language the user used.${instructions ? `\nAdditional instructions: ${instructions}` : ''}

<session>
${transcript(messages)}
</session>`;
  const r = await client.chat({
    messages: [
      { role: 'system', content: 'You write precise, dense summaries of software engineering sessions.' },
      { role: 'user', content: prompt },
    ],
    signal,
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
