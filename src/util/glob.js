// Conversión de patrones glob a expresiones regulares.

function escapeRe(s) {
  return s.replace(/[.+^$()|[\]\\]/g, '\\$&');
}

export function globToRegex(glob, { caseInsensitive = process.platform === 'win32' } = {}) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) {
        const alts = glob.slice(i + 1, end).split(',').map((a) => escapeRe(a).replace(/\*/g, '[^/]*'));
        re += `(?:${alts.join('|')})`;
        i = end;
      } else re += '\\{';
    } else if (ch === '\\') re += '/';
    else re += escapeRe(ch);
  }
  return new RegExp(`^${re}$`, caseInsensitive ? 'i' : '');
}

// Si el patrón no tiene "/", se compara contra el nombre del archivo.
export function makeMatcher(glob) {
  if (!glob) return () => true;
  const re = globToRegex(glob);
  const basenameOnly = !glob.includes('/');
  return (relPosix) => re.test(basenameOnly ? relPosix.split('/').pop() : relPosix);
}

// Comodín simple para reglas de permisos: "*" = cualquier cosa.
export function wildcardMatch(pattern, value) {
  const re = new RegExp(`^${pattern.split('*').map(escapeRe).join('.*')}$`, 's');
  return re.test(value);
}
