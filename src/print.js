// Modo no interactivo: codice -p "tarea". El texto va a stdout; el registro de herramientas, a stderr.
import { configureOutput } from './ui/output.js';
import * as ui from './ui/output.js';
import { c } from './ui/theme.js';
import { createUI } from './ui/bridge.js';
import { Agent } from './agent/agent.js';
import { expandMentions, describeError, ensureModel } from './repl.js';

function printView(runtime, { json }) {
  return {
    thinking() {},
    text(t) { if (!json) process.stdout.write(t); },
    reasoning() {},
    endTurn() {},
    tokens() {},
    toolStart() {},
    toolEnd(name, summary, r) {
      process.stderr.write(`${c.dim(`${r.ok ? '●' : '✗'} ${name}${summary ? `(${summary})` : ''}`)}\n`);
      if (r.text) process.stderr.write(`${c.dim(`  └ ${String(r.text).split('\n')[0]}`)}\n`);
    },
    notice(t) { process.stderr.write(`${c.warning(`⚠ ${t}`)}\n`); },
    pause() {},
  };
}

export async function runPrint(runtime, prompt, { session, outputFormat = 'text' } = {}) {
  const json = outputFormat === 'json';
  configureOutput({ stream: process.stderr });
  runtime.ui = createUI({});
  runtime.sessionId = session.id;
  const { readActivity } = await import('./activity.js');
  runtime.recentActivity = readActivity(runtime.projectRoot, { limit: 10, excludeSession: session.id });
  if (!(await ensureModel(runtime))) return 2;
  const agent = new Agent(runtime, { messages: session.messages, view: printView(runtime, { json }) });
  const { text } = expandMentions(prompt, runtime.cwd);
  const t0 = Date.now();
  const turnStart = session.messages.length;
  runtime.checkpoints.beginTurn(turnStart, prompt);
  let turnError = null;
  const log = async () => {
    const { logActivity, summarizeTurn } = await import('./activity.js');
    logActivity(runtime.projectRoot, summarizeTurn({ prompt, messages: session.messages.slice(turnStart), files: [...(runtime.checkpoints.turns.at(-1)?.files.keys() || [])], error: turnError, session: session.id, model: runtime.settings.model, cwd: runtime.cwd }));
  };
  try {
    const r = await agent.run(text);
    session.model = runtime.settings.model;
    session.save();
    if (json) {
      process.stdout.write(`${JSON.stringify({ result: r.text, session_id: session.id, turns: r.turns, usage: { input_tokens: runtime.usage.input, output_tokens: runtime.usage.output }, duration_ms: Date.now() - t0, model: runtime.settings.model }, null, 2)}\n`);
    } else if (!r.text.endsWith('\n')) process.stdout.write('\n');
    return 0;
  } catch (e) {
    turnError = e.message;
    const [title, cause, action] = describeError(e, runtime);
    if (json) process.stdout.write(`${JSON.stringify({ error: title, detail: cause, hint: action })}\n`);
    else ui.errorBox(title, cause, action);
    return 1;
  } finally {
    await log();
    runtime.mcp.stopAll();
    const { localEngine } = await import('./local/engine.js');
    localEngine.stop();
  }
}
