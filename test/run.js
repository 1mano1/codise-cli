// Ejecutor de pruebas mínimo (sin dependencias): node test/run.js [filtro]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Carpeta de configuración aislada: nunca tocar la ~/.codice real.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codice-home-'));
process.env.CODICE_HOME = home;
process.env.NO_COLOR = '1';

const { unitTests } = await import('./unit.js');
const { e2eTests } = await import('./e2e.js');

const filter = process.argv[2] || '';
let passed = 0, failed = 0;

async function t(name, fn) {
  if (filter && !name.includes(filter)) return;
  const errors = [];
  const assert = (cond, msg) => { if (!cond) errors.push(msg); };
  const t0 = Date.now();
  try {
    await fn(assert);
  } catch (e) {
    errors.push(e.stack || e.message);
  }
  const ms = Date.now() - t0;
  if (errors.length) {
    failed++;
    console.log(`✗ ${name} (${ms} ms)`);
    for (const e of errors) console.log(`    ${e}`);
  } else {
    passed++;
    console.log(`✓ ${name} (${ms} ms)`);
  }
}

for (const suite of [unitTests, e2eTests]) await suite(t);
fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${passed} correctas, ${failed} fallidas`);
process.exitCode = failed ? 1 : 0;
