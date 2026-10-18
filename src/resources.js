// Carga de skills, agentes y comandos personalizados desde: incluidos, usuario, plugins y proyecto.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROOT, HOME } from './config.js';
import { listDirs, listFiles } from './util/fs.js';
import { parseFrontmatter, stringifyFrontmatter, toList } from './util/frontmatter.js';

// Directorios en orden de prioridad creciente (los últimos sobrescriben a los primeros).
export function resourceDirs(kind, { projectRoot, plugins = [], compat = true }) {
  const dirs = [];
  if (kind === 'agents') dirs.push({ dir: path.join(ROOT, 'agents'), source: 'incluido' });
  dirs.push({ dir: path.join(HOME, kind), source: 'usuario' });
  if (compat) dirs.push({ dir: path.join(os.homedir(), '.claude', kind), source: 'usuario' });
  for (const p of plugins) dirs.push({ dir: path.join(p.root, kind), source: `plugin: ${p.name}`, namespace: p.name });
  if (compat) dirs.push({ dir: path.join(projectRoot, '.claude', kind), source: 'proyecto' });
  dirs.push({ dir: path.join(projectRoot, '.codice', kind), source: 'proyecto' });
  return dirs.filter((d) => fs.existsSync(d.dir));
}

// ── Skills ───────────────────────────────────────────────────────
export function loadSkills(opts) {
  const out = {};
  for (const { dir, source, namespace } of resourceDirs('skills', opts)) {
    for (const name of listDirs(dir)) {
      const file = path.join(dir, name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const { data } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      const base = String(data.name || name);
      const id = namespace ? `${namespace}:${base}` : base;
      out[id] = {
        name: id,
        description: String(data.description || '').slice(0, 400),
        dir: path.join(dir, name),
        file,
        source,
        load: () => parseFrontmatter(fs.readFileSync(file, 'utf8')).body.trim(),
      };
    }
  }
  return out;
}

// ── Agentes ──────────────────────────────────────────────────────
export function loadAgents(opts) {
  const out = {};
  for (const { dir, source, namespace } of resourceDirs('agents', opts)) {
    for (const f of listFiles(dir, '.md')) {
      const file = path.join(dir, f);
      const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      const base = String(data.name || f.replace(/\.md$/, ''));
      const id = namespace ? `${namespace}:${base}` : base;
      out[id] = {
        name: id,
        description: String(data.description || '').replace(/\s+/g, ' ').slice(0, 500),
        tools: toList(data.tools),
        disallowedTools: toList(data.disallowedTools),
        model: data.model && data.model !== 'inherit' ? String(data.model) : null,
        provider: data.provider ? String(data.provider) : null,
        color: data.color || null,
        prompt: body.trim(),
        file,
        source,
      };
    }
  }
  return out;
}

export function saveAgent(scope, projectRoot, def) {
  const dir = scope === 'proyecto' ? path.join(projectRoot, '.codice', 'agents') : path.join(HOME, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const slug = String(def.name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'agente';
  const file = path.join(dir, `${slug}.md`);
  fs.writeFileSync(file, stringifyFrontmatter({
    name: slug,
    description: def.description,
    tools: def.tools?.length ? def.tools : undefined,
    model: def.model || undefined,
    provider: def.provider || undefined,
  }, `${def.prompt.trim()}\n`));
  return file;
}

// ── Comandos personalizados ──────────────────────────────────────
export function loadCommands(opts) {
  const out = {};
  for (const { dir, source, namespace } of resourceDirs('commands', opts)) {
    const visit = (d, prefix) => {
      for (const f of listFiles(d, '.md')) {
        const file = path.join(d, f);
        const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
        const base = `${prefix}${f.replace(/\.md$/, '')}`;
        const id = namespace ? `${namespace}:${base}` : base;
        out[id] = {
          name: id,
          description: String(data.description || body.trim().split('\n')[0] || '').slice(0, 120),
          argumentHint: data['argument-hint'] || '',
          model: data.model || null,
          template: body,
          file,
          source,
        };
      }
      for (const sub of listDirs(d)) visit(path.join(d, sub), `${prefix}${sub}:`);
    };
    visit(dir, '');
  }
  return out;
}

// Sustituye $ARGUMENTS, $1..$9 y ejecuta !`comando` (requiere runShell).
export async function expandCommand(cmd, args, { runShell, cwd } = {}) {
  const parts = args.match(/"[^"]*"|\S+/g)?.map((s) => s.replace(/^"|"$/g, '')) || [];
  let text = cmd.template.replace(/\$ARGUMENTS/g, args).replace(/\$(\d)/g, (_, n) => parts[Number(n) - 1] ?? '');
  if (runShell) {
    const re = /!`([^`]+)`/g;
    const jobs = [...text.matchAll(re)];
    for (const m of jobs) {
      const r = await runShell(m[1], { cwd, timeout: 30000 });
      text = text.replace(m[0], r.output.trim());
    }
  }
  if (!cmd.template.includes('$ARGUMENTS') && args && !/\$\d/.test(cmd.template)) text += `\n\n${args}`;
  return text.trim();
}
