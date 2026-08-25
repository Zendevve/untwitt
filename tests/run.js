// Test harness entry point.
//
// Loads each suite in tests/suites/ in deterministic filename order, runs
// it as an async function, and prints one summary line per suite. Exits
// 0 if every suite passes, 1 otherwise.

import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const SUITES_DIR = join(process.cwd(), 'tests', 'suites');

function discoverSuites() {
  const entries = readdirSync(SUITES_DIR)
    .filter((name) => name.endsWith('.js'))
    .sort();
  return entries;
}

async function runOne(file) {
  const abs = join(SUITES_DIR, file);
  const mod = await import(pathToFileURL(abs).href);
  if (typeof mod.run !== 'function') {
    return {
      name: file,
      pass: 0,
      fail: 1,
      errors: [{ name: 'SUITE_ERROR', message: 'suite did not export run()' }],
    };
  }
  try {
    const result = await mod.run({ require: createRequire(dirname(abs) + '/_x.js') });
    return {
      name: result.name || file.replace(/\.js$/, ''),
      pass: Number(result.pass) || 0,
      fail: Number(result.fail) || 0,
      errors: Array.isArray(result.errors) ? result.errors : [],
    };
  } catch (err) {
    return {
      name: file.replace(/\.js$/, ''),
      pass: 0,
      fail: 1,
      errors: [{ name: 'SUITE_THREW', message: err && err.message ? err.message : String(err) }],
    };
  }
}

async function main() {
  const files = discoverSuites();
  const results = [];
  let totalPass = 0;
  let totalFail = 0;
  const dropped = [];

  for (const file of files) {
    const result = await runOne(file);
    results.push(result);
    if (result.fail > 0) {
      for (const e of result.errors) {
        console.error(`  - ${e.name || 'error'}: ${e.message || ''}`);
      }
    }
    console.log(`SUITE: ${result.name} ${result.pass} passed, ${result.fail} failed`);
    totalPass += result.pass;
    totalFail += result.fail;
  }

  for (const file of files) {
    // Detect dropped suites: a file named *.dropped.js is the contract
    // for a suite we intentionally skipped. We don't currently support
    // dropping mid-run; if a suite cannot be made to pass, the suite file
    // itself is expected to log a "DROPPED" line. We surface those lines
    // by collecting them from the per-suite output above. Since we
    // already printed everything, the dropped list is empty unless the
    // runner recorded one.
    if (file.endsWith('.dropped.js')) {
      dropped.push(file.replace(/\.dropped\.js$/, ''));
    }
  }

  for (const d of dropped) {
    console.log(`DROPPED: ${d}`);
  }

  if (totalFail > 0 || dropped.length > 0) {
    console.log(`OVERALL: FAIL (${totalPass} passed, ${totalFail} failed${dropped.length ? `, ${dropped.length} dropped` : ''})`);
    process.exit(1);
  }
  console.log(`OVERALL: PASS (${totalPass} passed, ${totalFail} failed)`);
  process.exit(0);
}

main();
