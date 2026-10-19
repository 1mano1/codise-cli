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

  // El sandbox bloqueó un comando (diseño v3 · F): explica qué y por qué, y ofrece permitirlo o salir una vez.
  async function sandboxBlocked({ command, block, agentLabel }) {
    pause();
    const pre = [];
    const who = agentLabel ? c.agent(` · ${agentLabel}`) : '';
    pre.push(`${c.warning(L('⛨ El sandbox bloqueó · ', '⛨ The sandbox blocked · '), { bold: true })}${style('Bash', { bold: true, fg: 'text/primary' })}${who}`);
    wrap(command, Math.max(20, width() - 6)).forEach((l, i) => pre.push(`  ${c.dim(i ? ' ' : '$')} ${style(l, { bold: true, fg: 'text/primary' })}`));
    if (block.kind === 'network') {
      pre.push(`  ${c.muted(L('Sin red: no pudo conectar con ', 'No network: could not connect to '))}${block.host ? c.info(block.host) : c.muted(L('internet', 'the internet'))}${c.dim(L('  (el sandbox no tiene internet)', '  (the sandbox has no internet)'))}`);
    } else {
      pre.push(`  ${c.muted(L('Solo puede escribir en la carpeta del proyecto', 'It can only write inside the project folder'))}${block.path ? c.dim(` · ${block.path}`) : ''}`);
    }
    pre.push('');
    const options = [];
    if (block.kind === 'network' && block.host) options.push({ label: L(`Permitir red a ${block.host} en este proyecto`, `Allow network to ${block.host} in this project`), value: 'allow' });
    options.push({ label: L('Ejecutar fuera del sandbox solo esta vez', 'Run outside the sandbox just this once'), value: 'outside' });
    options.push({ label: L('No, y decirle qué hacer diferente', 'No, and tell it what to do instead'), value: 'no', hint: '(esc)', hintColor: 'status/info' });
    const choice = await select(input, { pre, options, footer: L('↑↓ elegir · enter confirmar · esc = no', '↑↓ move · enter select · esc = no'), erase: true, tone: 'status/warning' });
    if (choice === 'allow' || choice === 'outside') return { choice };
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
      sandboxBlocked,
    };
  }

  return { interactive, input, forTool, permission, select: (o) => { pause(); return select(input, o); }, isScreenReader };
}

export function printNotice(text) {
  ensureNewline();
  println(`${c.warning('⚠', { bold: true })} ${c.warning(text)}`);
}
