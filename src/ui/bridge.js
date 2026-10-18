// Puente entre herramientas/agentes y la interfaz: diálogo de permisos, menús, preguntas, diffs diferidos.
import { c, style } from './theme.js';
import { diffLines, printDiff, printTodos, MarkdownStream, getHeaderMark, setHeaderMark, println, ensureNewline, isScreenReader } from './output.js';
import { select } from './select.js';

export function createUI({ input = null, spinner = null } = {}) {
  const interactive = Boolean(input);

  const pause = () => spinner?.stop();

  async function permission({ tool, args, preview, rule, agentLabel }) {
    pause();
    const mark = getHeaderMark();
    const pre = [];
    const who = agentLabel ? c.agent(` · ${agentLabel}`) : '';
    pre.push(`${c.warning('⚠ Permiso requerido · ', { bold: true })}${style(tool.name, { bold: true, fg: 'text/primary' })}${who}`);
    let question = `¿Permitir que Códice use ${tool.name}?`;
    if (preview?.kind === 'command') {
      pre.push(`  ${c.dim('$')} ${style(String(preview.command), { bold: true, fg: 'text/primary' })}`);
      if (preview.description) pre.push(`  ${c.dim(preview.description, { italic: true })}`);
      question = '¿Permitir que Códice ejecute este comando?';
    } else if (preview?.kind === 'diff') {
      pre.push(`  ${c.info(preview.file)}${preview.created ? c.dim(' (archivo nuevo)') : ''}`);
      pre.push(...diffLines(preview.old, preview.new, { startLine: preview.startLine || 1, maxLines: 16, indent: '  ' }));
      question = preview.created ? '¿Crear este archivo?' : '¿Aplicar este cambio?';
    } else {
      const json = JSON.stringify(args);
      pre.push(`  ${c.muted(json.length > 300 ? `${json.slice(0, 300)}…` : json)}`);
    }
    pre.push('');
    const choice = await select(input, {
      pre,
      title: c.primary(question),
      options: [
        { label: 'Sí', value: 'yes' },
        { label: 'Sí, y no volver a preguntar por', value: 'always', hint: rule, hintColor: 'status/info' },
        { label: 'No, y decirle qué hacer diferente', value: 'no', hint: '(esc)', hintColor: 'status/info' },
      ],
      footer: '↑↓ elegir · enter confirmar · 1-3 directo · esc = no',
      erase: true,
    });
    if (choice === 'yes' || choice === 'always') {
      setHeaderMark(mark);
      return { choice };
    }
    ensureNewline();
    const feedback = await input.question(`${c.accent('›', { bold: true })} ${c.muted('¿Qué debería hacer en su lugar? (enter para omitir) ')}`);
    return { choice: 'no', feedback: (feedback || '').trim() };
  }

  // UI para una ejecución concreta de herramienta: los diffs y tareas se imprimen tras el resultado.
  function forTool(deferred) {
    return {
      interactive,
      diff: (oldT, newT, startLine, o = {}) => deferred.push(() => printDiff(oldT, newT, { startLine, ...o })),
      todos: (list) => deferred.push(() => printTodos(list)),
      markdown: (text) => { pause(); const md = new MarkdownStream(); md.push(`${text}\n`); md.flush(); },
      select: async (o) => { pause(); return select(input, o); },
      question: async (q) => { pause(); return input ? input.question(`${c.accent('›', { bold: true })} ${q}`) : ''; },
      permission,
    };
  }

  return { interactive, input, forTool, permission, select: (o) => { pause(); return select(input, o); }, isScreenReader };
}

export function printNotice(text) {
  ensureNewline();
  println(`${c.warning('⚠', { bold: true })} ${c.warning(text)}`);
}
