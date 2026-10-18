// Herramientas de control: TodoWrite, Task (subagentes), Skill, AskUser, ExitPlanMode.

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
  summary: (a) => `${(a.todos || []).length} tareas`,
  async run(a, ctx) {
    const todos = (a.todos || []).map((t) => ({ content: String(t.content), status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending' }));
    ctx.runtime.todos = todos;
    ctx.ui?.todos(todos);
    const done = todos.filter((t) => t.status === 'completed').length;
    return { content: `Lista actualizada (${done}/${todos.length} completadas).`, display: `Plan actualizado · ${done}/${todos.length}` };
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
    return { content: r.text || '(el subagente no devolvió texto)', display: `Subagente terminó · ${r.turns} pasos${r.tokens ? ` · ${r.tokens} tokens` : ''}` };
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
    if (!s) throw new Error(`No existe la skill "${a.name}". Disponibles: ${Object.keys(ctx.runtime.skills).join(', ') || 'ninguna'}`);
    const body = s.load();
    return {
      content: `Skill "${s.name}" cargada. Directorio base: ${s.dir}\n${a.args ? `Argumentos: ${a.args}\n` : ''}\n${body}`,
      display: `Skill cargada · ${s.source}`,
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
    if (!ctx.ui?.interactive) return { content: 'El usuario no está disponible (modo no interactivo). Decide tú con el criterio más razonable y explícalo.', display: 'Sin usuario' };
    const options = (a.options || []).slice(0, 6).map((o) => ({ label: String(o), value: String(o) }));
    options.push({ label: 'Otra respuesta…', value: '__other__' });
    let answer = await ctx.ui.select({ title: a.question, options });
    if (answer === '__other__') answer = await ctx.ui.question('Tu respuesta: ');
    if (answer == null || answer === '') return { content: 'El usuario no respondió.', display: 'Sin respuesta' };
    return { content: `Respuesta del usuario: ${answer}`, display: answer };
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
  summary: () => 'plan listo',
  async run(a, ctx) {
    ctx.ui?.markdown(a.plan);
    if (!ctx.ui?.interactive) return { content: 'Modo no interactivo: el plan queda presentado, sin aprobación.', display: 'Plan presentado' };
    const choice = await ctx.ui.select({
      title: '¿Apruebas el plan?',
      options: [
        { label: 'Sí, y aceptar ediciones automáticamente', value: 'acceptEdits' },
        { label: 'Sí, pidiendo permiso para cada cambio', value: 'default' },
        { label: 'No, sigue planificando', value: 'no' },
      ],
    });
    if (choice === 'acceptEdits' || choice === 'default') {
      ctx.runtime.setPermissionMode(choice);
      return { content: `El usuario aprobó el plan. Modo de permisos: ${choice}. Empieza a implementarlo.`, display: 'Plan aprobado' };
    }
    const fb = await ctx.ui.question('¿Qué cambiarías del plan? ');
    return { content: `El usuario NO aprobó el plan. Sigue en modo plan.${fb ? ` Comentarios: ${fb}` : ''}`, display: 'Plan rechazado' };
  },
};
