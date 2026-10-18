// Puente entre herramientas/agentes y la interfaz: diálogo de permisos, menús, preguntas, diffs diferidos.
import { c, style } from './theme.js';
import { diffLines, printDiff, printTodos, MarkdownStream, getHeaderMark, setHeaderMark, println, ensureNewline, isScreenReader, wrap, width } from './output.js';
import { select } from './select.js';
import { L } from '../i18n.js';

export function createUI({ input = null, spinner = null } = {}) {
  const interactive = Boolean(input);

  const pause = () => spinner?.stop();

  async function permission({ tool, args, preview, rule, agentLabel }) {
    pause();
    const mark = getHeaderMark();
    const pre = [];
    const who = agentLabel ? c.agent(` · ${agentLabel}`) : '';
    pre.push(`${c.warning(L('⚠ Permiso requerido · ', '⚠ Permission required · '), { bold: true })}${style(tool.name, { bold: true, fg: 'text/primary' })}${who}`);
    let question = L(`¿Permitir que Códice use ${tool.name}?`, `Allow Códice to use ${tool.name}?`);
    if (preview?.kind === 'command') {
      // comandos largos: se muestran completos en varios renglones (no cortados)
      const cmdLines = wrap(String(preview.command), Math.max(20, width() - 6));
      cmdLines.forEach((l, i) => pre.push(`  ${c.dim(i ? ' ' : '$')} ${style(l, { bold: true, fg: 'text/primary' })}`));
      if (preview.description) pre.push(`  ${c.dim(preview.description, { italic: true })}`);
      question = L('¿Permitir que Códice ejecute este comando?', 'Allow Códice to run this command?');
    } else if (preview?.kind === 'diff') {
      pre.push(`  ${c.info(preview.file)}${preview.created ? c.dim(L(' (archivo nuevo)', ' (new file)')) : ''}`);
      pre.push(...diffLines(preview.old, preview.new, { startLine: preview.startLine || 1, maxLines: 16, indent: '  ' }));
      question = preview.created ? L('¿Crear este archivo?', 'Create this file?') : L('¿Aplicar este cambio?', 'Apply this change?');
    } else {
      const json = JSON.stringify(args);
      pre.push(`  ${c.muted(json.length > 300 ? `${json.slice(0, 300)}…` : json)}`);
    }
    pre.push('');
    const choice = await select(input, {
      pre,
      title: c.primary(question),
      options: [
        { label: L('Sí', 'Yes'), value: 'yes' },
        { label: L('Sí, y no volver a preguntar por', "Yes, and don't ask again for"), value: 'always', hint: rule, hintColor: 'status/info' },
        { label: L('No, y decirle qué hacer diferente', 'No, and tell it what to do instead'), value: 'no', hint: '(esc)', hintColor: 'status/info' },
      ],
      footer: L('↑↓ elegir · enter confirmar · esc = no', '↑↓ move · enter select · esc = no'),
      erase: true,
      tone: 'status/warning',
    });
    if (choice === 'yes' || choice === 'always') {
      setHeaderMark(mark);
      return { choice };
    }
    ensureNewline();
    const feedback = await input.question(`${c.accent('›', { bold: true })} ${c.muted(L('¿Qué debería hacer en su lugar? (enter para omitir) ', 'What should it do instead? (enter to skip) '))}`);
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
