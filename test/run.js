// Ejecutor de pruebas mínimo (sin dependencias): node test/run.js [filtro]
import { e2eTests } from './e2e.js';

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

const suites = [e2eTests];
for (const s of suites) await s(t);
console.log(`\n${passed} correctas, ${failed} fallidas`);
process.exitCode = failed ? 1 : 0;
