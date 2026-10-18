// Herramientas de control: TodoWrite, Task (subagentes), Skill, AskUser, ExitPlanMode.
import { L } from '../i18n.js';

export const TodoWrite = {
  name: 'TodoWrite',
  readOnly: true,
  description: 'Create or update the task list for multi-step work. Send the FULL list each time. Exactly one task should be "in_progress" while working. Mark tasks "completed" as soon as they are done.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  summary: (a) => L(`${(a.todos || []).length} tareas`, `${(a.todos || []).length} tasks`),
  async run(a, ctx) {
    const todos = (a.todos || []).map((t) => ({ content: String(t.content), status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending' }));
    ctx.runtime.todos = todos;
    ctx.ui?.todos(todos);
    const done = todos.filter((t) => t.status === 'completed').length;
    return { content: `Task list updated (${done}/${todos.length} completed).`, display: L(`Plan actualizado · ${done}/${todos.length}`, `Plan updated · ${done}/${todos.length}`) };
  },
};

export const Task = {
  name: 'Task',
  readOnly: true, // el subagente pide sus propios permisos
  parallelSafe: true,
  description: 'Launch a subagent to handle a self-contained task autonomously. Several Task calls in the same reply run in parallel.',
  describe(runtime) {
    const list = Object.values(runtime.agents).map((a) => `- ${a.name}: ${a.description}`).join('\n');
    return `Launch a subagent to handle a complex, self-contained task autonomously (searches across many files, reviews, independent sub-tasks). The subagent has its own context and returns a final report; it cannot see this conversation, so give it a complete, detailed prompt. Several Task calls in the same reply run in parallel.\n\nAvailable agents (subagent_type):\n${list}`;
  },
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short description (3-5 words)' },
      prompt: { type: 'string', description: 'Complete instructions for the subagent' },
      subagent_type: { type: 'string', description: 'Agent name (default general-purpose)' },
    },
    required: ['description', 'prompt'],
  },
  summary: (a) => `${a.subagent_type || 'general-purpose'} · "${String(a.description || '').slice(0, 60)}"`,
  async run(a, ctx) {
    const r = await ctx.runtime.runSubagent(a.subagent_type || 'general-purpose', String(a.prompt), {
      signal: ctx.signal,
      depth: (ctx.depth || 0) + 1,
      description: a.description,
    });
    return { content: r.text || '(the subagent returned no text)', display: L(`Subagente terminó · ${r.turns} pasos${r.tokens ? ` · ${r.tokens} tokens` : ''}`, `Subagent finished · ${r.turns} steps${r.tokens ? ` · ${r.tokens} tokens` : ''}`) };
  },
};

export const Skill = {
  name: 'Skill',
  readOnly: true,
  description: 'Load a skill: specialized instructions for a type of task. Load it BEFORE doing the task when it matches.',
  describe(runtime) {
    const list = Object.values(runtime.skills).map((s) => `- ${s.name}: ${s.description}`).join('\n') || '(none installed)';
    return `Load a skill (specialized instructions and resources for a type of task). When the user's request matches a skill, load it first and follow it.\n\nAvailable skills:\n${list}`;
  },
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name' },
      args: { type: 'string', description: 'Optional arguments' },
    },
    required: ['name'],
  },
  summary: (a) => a.name,
  async run(a, ctx) {
    const s = ctx.runtime.skills[a.name] || Object.values(ctx.runtime.skills).find((x) => x.name.toLowerCase() === String(a.name).toLowerCase());
    if (!s) throw new Error(`Skill "${a.name}" does not exist. Available: ${Object.keys(ctx.runtime.skills).join(', ') || 'none'}`);
    const body = s.load();
    return {
      content: `Skill "${s.name}" loaded. Base directory: ${s.dir}\n${a.args ? `Arguments: ${a.args}\n` : ''}\n${body}`,
      display: L(`Skill cargada · ${s.source}`, `Skill loaded · ${s.source}`),
    };
  },
};

export const AskUser = {
  name: 'AskUser',
  readOnly: true,
  description: 'Ask the user a question when you need a decision you cannot make yourself. Provide 2-4 short options; the user can also answer freely.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      options: { type: 'array', items: { type: 'string' } },
    },
    required: ['question'],
  },
  summary: (a) => `"${String(a.question).slice(0, 80)}"`,
  async run(a, ctx) {
    if (!ctx.ui?.interactive) return { content: 'The user is not available (non-interactive mode). Decide with your best judgment and explain it.', display: L('Sin usuario', 'No user') };
    const options = (a.options || []).slice(0, 6).map((o) => ({ label: String(o), value: String(o) }));
    options.push({ label: L('Otra respuesta…', 'Other answer…'), value: '__other__' });
    let answer = await ctx.ui.select({ title: a.question, options });
    if (answer === '__other__') answer = await ctx.ui.question(L('Tu respuesta: ', 'Your answer: '));
    if (answer == null || answer === '') return { content: 'The user did not answer.', display: L('Sin respuesta', 'No answer') };
    return { content: `User answer: ${answer}`, display: answer };
  },
};

export const ExitPlanMode = {
  name: 'ExitPlanMode',
  readOnly: true,
  planOnly: true,
  description: 'In plan mode, present your finished plan to the user for approval. If approved, plan mode ends and you can start implementing.',
  parameters: {
    type: 'object',
    properties: { plan: { type: 'string', description: 'The plan in Markdown, concise' } },
    required: ['plan'],
  },
  summary: () => L('plan listo', 'plan ready'),
  async run(a, ctx) {
    ctx.ui?.markdown(a.plan);
    if (!ctx.ui?.interactive) return { content: 'Non-interactive mode: the plan is presented without approval.', display: L('Plan presentado', 'Plan presented') };
    const choice = await ctx.ui.select({
      title: L('¿Apruebas el plan?', 'Do you approve the plan?'),
      options: [
        { label: L('Sí, y aceptar ediciones automáticamente', 'Yes, and auto-accept edits'), value: 'acceptEdits' },
        { label: L('Sí, pidiendo permiso para cada cambio', 'Yes, asking before each change'), value: 'default' },
        { label: L('No, sigue planificando', 'No, keep planning'), value: 'no' },
      ],
    });
    if (choice === 'acceptEdits' || choice === 'default') {
      ctx.runtime.setPermissionMode(choice);
      return { content: `The user approved the plan. Permission mode: ${choice}. Start implementing it.`, display: L('Plan aprobado', 'Plan approved') };
    }
    const fb = await ctx.ui.question(L('¿Qué cambiarías del plan? ', 'What would you change in the plan? '));
    return { content: `The user did NOT approve the plan. Stay in plan mode.${fb ? ` Feedback: ${fb}` : ''}`, display: L('Plan rechazado', 'Plan rejected') };
  },
};
