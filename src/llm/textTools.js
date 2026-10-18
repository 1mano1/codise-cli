// Modo "prompt" para modelos sin tool calling nativo: las herramientas se describen en el system prompt
// y el modelo responde con bloques <tool_call>{"name": "...", "arguments": {...}}</tool_call>.

export function toolsPrompt(tools, { lean = false } = {}) {
  const list = tools.map((t) => {
    const params = JSON.stringify(t.parameters);
    const desc = lean ? String(t.description).split('\n')[0] : t.description;
    return `## ${t.name}\n${desc}\nParameters (JSON Schema): ${params}`;
  }).join('\n\n');
  return `# Tool use
You can call tools. To call a tool, output EXACTLY this format (one block per call):
<tool_call>
{"name": "ToolName", "arguments": {"param": "value"}}
</tool_call>
Rules:
- The content must be valid JSON. Use only the tools listed below.
- You may call several tools in one reply. After calling tools, STOP and wait: results arrive in <tool_result> blocks.
- When the task is complete, answer normally without any <tool_call>.

# Available tools

${list}`;
}

function parseJSONLoose(s) {
  let t = s.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    // comas finales y comillas simples comunes en modelos pequeños
    t = t.replace(/,\s*([}\]])/g, '$1');
    try {
      return JSON.parse(t);
    } catch {
      const m = t.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1'));
      throw new Error('JSON inválido');
    }
  }
}

export function parseTextToolCalls(text) {
  const calls = [];
  const errors = [];
  const re = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      const j = parseJSONLoose(raw);
      const name = j.name || j.tool || j.function?.name;
      let args = j.arguments ?? j.parameters ?? j.args ?? j.input ?? j.function?.arguments ?? {};
      if (typeof args === 'string') args = parseJSONLoose(args);
      if (name) calls.push({ id: `call_${Math.random().toString(36).slice(2, 10)}`, name, arguments: JSON.stringify(args) });
    } catch (e) {
      errors.push(`${e.message}: ${raw.slice(0, 200)}`);
    }
  }
  const cleaned = text.replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, '').trim();
  return { calls, cleaned, errors };
}

// Convierte mensajes en formato nativo (tool_calls / role:"tool") al formato de texto.
export function toPromptMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const blocks = m.tool_calls.map((tc) => {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* se deja vacío */ }
        return `<tool_call>\n${JSON.stringify({ name: tc.function.name, arguments: args })}\n</tool_call>`;
      }).join('\n');
      out.push({ role: 'assistant', content: [m.content, blocks].filter(Boolean).join('\n') });
    } else if (m.role === 'tool') {
      const block = `<tool_result name="${m.name || 'tool'}">\n${m.content}\n</tool_result>`;
      const prev = out.at(-1);
      if (prev && prev.role === 'user' && prev._toolResults) prev.content += `\n${block}`;
      else out.push({ role: 'user', content: block, _toolResults: true });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out.map(({ _toolResults, ...m }) => m);
}
