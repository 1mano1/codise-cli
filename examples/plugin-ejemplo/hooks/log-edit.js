// Registra cada archivo editado en .codice/ediciones.log del proyecto.
const fs = require('node:fs');
const path = require('node:path');

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const file = data.tool_input?.file_path;
    if (!file) return;
    const dir = path.join(process.env.CODICE_PROJECT_DIR || process.cwd(), '.codice');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'ediciones.log'), `${new Date().toISOString()} ${data.tool_name} ${file}\n`);
  } catch { /* entrada inválida */ }
});
