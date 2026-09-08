/**
 * SIGKILL chaos suite: the load-bearing gate.
 *
 * For every boundary in the deal lifecycle: spawn a real buyer process, kill it
 * with SIGKILL (no handlers, no flush, no cleanup: the process simply stops)
 * the instant it announces that boundary, then spawn a fresh process over the
 * same store and let it finish.
 *
 * The assertion that matters is the settlement ledger: exactly one line per
 * deal, no matter where the kill landed. A second line is a double-pay, which
 * is the failure this entire project exists to prevent.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FileDriver } from '../memory/driver-file.mjs';
import { DealMemory } from '../memory/deals.mjs';

const RUNNER = fileURLToPath(new URL('./buyer-run.mjs', import.meta.url));
const BOUNDARIES = ['AT:INTENT', 'AT:QUOTED', 'AT:AUTHORIZED', 'AT:IN_FLIGHT', 'AT:SETTLED', 'AT:PAID', 'AT:DELIVERED'];

/** Run the buyer. If `killAt` is given, SIGKILL it the moment it prints that line. */
function run(store, ledger, dealId, killAt = null) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [RUNNER, store, ledger, dealId], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', killed = false;
    child.stdout.on('data', d => {
      out += d.toString();
      if (killAt && !killed && out.split('\n').includes(killAt)) {
        killed = true;
        child.kill('SIGKILL');   // no chance to clean up, flush, or finish a write
      }
    });
    child.stderr.on('data', d => { out += d.toString(); });
    child.on('close', (code, signal) => resolve({ out, code, signal, killed }));
  });
}

const ledgerLines = ledger =>
  fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean) : [];

let passed = 0, failed = 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airtight-chaos-'));

console.log('SIGKILL chaos suite: killing a real process at every boundary\n');

for (const boundary of BOUNDARIES) {
  const store = path.join(tmp, boundary.replace(/\W/g, '_'));
  const ledger = store + '.ledger';
  const dealId = 'dt-chaos-' + boundary.replace(/\W/g, '').toLowerCase();

  const first = await run(store, ledger, dealId, boundary);
  const linesAfterKill = ledgerLines(ledger).length;

  // Respawn cold. New process, no shared state, only what reached the store.
  const second = await run(store, ledger, dealId);
  const lines = ledgerLines(ledger);
  const deal = await new DealMemory(new FileDriver(store)).get(dealId);

  const problems = [];
  if (!first.killed) problems.push(`never reached ${boundary}`);
  if (first.signal !== 'SIGKILL') problems.push(`first process exited ${first.code}/${first.signal}, expected SIGKILL`);
  if (lines.length !== 1) problems.push(`ledger has ${lines.length} settlements, expected exactly 1`);
  if (deal?.state !== 'CLOSED') problems.push(`final state ${deal?.state}, expected CLOSED`);
  if (!second.out.includes('DONE')) problems.push('resumed process did not complete');

  const resumedFrom = /RESUMED:\w+:(\w+|-):/.exec(second.out)?.[1] ?? '(fresh)';
  if (problems.length) {
    failed++;
    console.log(`  FAIL  kill at ${boundary.padEnd(14)} → ${problems.join('; ')}`);
    console.log(`        first:  ${JSON.stringify(first.out)}`);
    console.log(`        second: ${JSON.stringify(second.out)}`);
  } else {
    passed++;
    console.log(`  ok    kill at ${boundary.padEnd(14)} → resumed at ${resumedFrom.padEnd(10)} · 1 settlement · CLOSED`);
  }
}

// ── the deletion gate ──────────────────────────────────────────────────────
{
  const store = path.join(tmp, 'deletion');
  const ledger = store + '.ledger';
  const dealId = 'dt-chaos-deletion';
  await run(store, ledger, dealId, 'AT:AUTHORIZED');
  new FileDriver(store).destroyAll();          // wipe for real, not archive

  const after = await run(store, ledger, dealId);
  // With no record the agent must not invent one and pay. It opens a fresh deal
  // only because the id is free; the ledger is what proves it did not re-pay a
  // deal it could no longer verify.
  const ok = ledgerLines(ledger).length <= 1;
  if (ok) { passed++; console.log(`  ok    memory deleted        → no unverified settlement`); }
  else { failed++; console.log(`  FAIL  memory deleted        → ${ledgerLines(ledger).length} settlements`); }
  assert.ok(after.out.length > 0);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failed ? 'FAIL' : 'PASS'} sigkill.test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
