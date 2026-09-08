/**
 * Task Checkpointing.
 *
 * Two things this suite has to prove beyond the happy path:
 *   1. it never touches a payment record, and payments never touch a task one;
 *   2. a real process really killed really resumes: signals are tested by
 *      sending signals to a spawned child, not by calling the handler directly.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FileDriver } from '../memory/driver-file.mjs';
import { DealMemory, CAT } from '../memory/deals.mjs';
import { TaskMemory, TASK_KEY, TASK_EVENT, newTaskId, memoryPressure } from '../tasks/checkpoint.mjs';
import { checkpointIfPressured } from '../tasks/guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'fixtures', 'crashy-task.mjs');

let passed = 0;
const roots = [];
function store() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'airtight-task-'));
  roots.push(r);
  return r;
}
const fresh = () => new TaskMemory(new FileDriver(store()));
async function t(name, fn) { await fn(); passed++; console.log(`  ok  ${name}`); }

// ── lifecycle ──────────────────────────────────────────────────────────────

await t('start opens a task at STARTED, step 0', async () => {
  const mem = fresh();
  const rec = await mem.start('import', { label: 'Nightly import', steps: 4 });
  assert.strictEqual(rec.state, 'STARTED');
  assert.strictEqual(rec.step, 0);
  assert.strictEqual(rec.total_steps, 4);
  assert.ok(rec.started_at && rec.last_checkpoint_at);
});

await t('start is idempotent: calling it every boot is safe', async () => {
  const mem = fresh();
  await mem.start('import', { label: 'first' });
  await mem.checkpoint('import', 2);
  const again = await mem.start('import', { label: 'second' });
  assert.strictEqual(again.step, 2, 'must not reset progress');
  assert.strictEqual(again.label, 'first');
});

await t('checkpoints advance and overwrite rather than append', async () => {
  const mem = fresh();
  await mem.start('t');
  await mem.checkpoint('t', 0);
  await mem.checkpoint('t', 1);
  const rec = await mem.checkpoint('t', 2);
  assert.strictEqual(rec.state, 'STEP');
  assert.strictEqual(rec.step, 2);
  assert.ok(!('transitions' in rec), 'the record is a position, not a history');
});

await t('a checkpoint may not rewind', async () => {
  const mem = fresh();
  await mem.start('t');
  await mem.checkpoint('t', 3);
  await assert.rejects(() => mem.checkpoint('t', 1), /refusing to rewind/);
  await assert.rejects(() => mem.checkpoint('t', -1), /non-negative integer/);
});

await t('checkpointing an unknown or finished task is refused', async () => {
  const mem = fresh();
  await assert.rejects(() => mem.checkpoint('ghost', 0), /no task record/);
  await mem.start('t'); await mem.done('t');
  await assert.rejects(() => mem.checkpoint('t', 1), /already DONE/);
});

// ── resume ─────────────────────────────────────────────────────────────────

await t('resume returns the next step to run', async () => {
  const mem = fresh();
  assert.deepStrictEqual(
    (await mem.resume('none')),
    { found: false, state: null, step: 0, resumeFrom: 0, reason: null, record: null },
  );
  await mem.start('t', { steps: 5 });
  assert.strictEqual((await mem.resume('t')).resumeFrom, 0, 'STARTED resumes at 0');
  await mem.checkpoint('t', 0);
  assert.strictEqual((await mem.resume('t')).resumeFrom, 1, 'step 0 done ⇒ run step 1');
  await mem.checkpoint('t', 3);
  assert.strictEqual((await mem.resume('t')).resumeFrom, 4);
});

await t('a cold TaskMemory resumes from storage alone', async () => {
  const root = store();
  const first = new TaskMemory(new FileDriver(root));
  await first.start('t', { steps: 9 });
  await first.checkpoint('t', 5, { reason: 'signal_SIGTERM' });

  const cold = new TaskMemory(new FileDriver(root));
  const r = await cold.resume('t');
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.resumeFrom, 6);
  assert.strictEqual(r.reason, 'signal_SIGTERM');
});

await t('fail records why but preserves the step', async () => {
  const mem = fresh();
  await mem.start('t');
  await mem.checkpoint('t', 2);
  const rec = await mem.fail('t', 'exception: disk full');
  assert.strictEqual(rec.state, 'FAILED');
  assert.strictEqual(rec.step, 2);
  assert.match(rec.reason, /disk full/);
  assert.strictEqual((await mem.resume('t')).resumeFrom, 3, 'a failure still resumes forward');
});

// ── isolation from Payment Safety ──────────────────────────────────────────

await t('tasks and payments never see each other, even on one driver', async () => {
  const root = store();
  const driver = new FileDriver(root);
  const tasks = new TaskMemory(driver);
  const deals = new DealMemory(driver);

  await tasks.start('shared-name', { label: 'a task' });
  await deals.open({
    dealId: 'shared-name', role: 'buyer',
    terms: { resource_url: 'https://x/y', pay_to: '0xA', network: 'base-sepolia',
             asset: '0xB', price_cap_usdc: 0.01, max_amount_required: '10000' },
  });

  // Same name, different TIERS: the task lives in HOT state, the deal in an
  // entity category. Neither record can reach the other.
  assert.strictEqual((await tasks.get('shared-name')).label, 'a task');
  assert.strictEqual((await deals.get('shared-name')).role, 'buyer');
  assert.deepStrictEqual(await tasks.list(), ['shared-name']);
  assert.ok(driver.listState().includes(TASK_KEY('shared-name')));
  assert.deepStrictEqual(await driver.list(CAT.DEAL), ['shared-name']);

  // Deleting every task leaves the payment record untouched.
  await tasks.forget('shared-name');
  assert.strictEqual(await tasks.get('shared-name'), null);
  assert.ok(await deals.get('shared-name'), 'a payment record must survive a task wipe');
});

await t('the task module writes only state and journal, never an entity', async () => {
  const root = store();
  const mem = new TaskMemory(new FileDriver(root));
  await mem.start('t', { steps: 2 });
  await mem.checkpoint('t', 0);
  await mem.advance('t', { action: 'called the pricing API', result: { cursor: 'p2' } });
  await mem.done('t');
  const dirs = fs.readdirSync(root).sort();
  assert.deepStrictEqual(dirs, ['_journal', '_state'], `wrote outside its tiers: ${dirs}`);
});

await t('advance records WHAT was done, for agents with no fixed plan', async () => {
  // A pipeline can say "step 5 of 9" because the code defines step 6. A ReAct
  // loop cannot: "5 actions done" says nothing about which. The journal is
  // what lets a resuming agent read its own history instead of guessing.
  const mem = fresh();
  await mem.start('agent', { steps: null });          // plan unknown
  await mem.advance('agent', { action: 'searched the catalogue', result: { hits: 12 } });
  await mem.advance('agent', { action: 'emailed the supplier', result: { id: 'msg-8812' } });

  const r = await mem.resume('agent');
  assert.strictEqual(r.step, 1);
  assert.strictEqual(r.resumeFrom, 2);
  assert.strictEqual(r.record.total_steps, null, 'an emergent task has no total');
  assert.strictEqual(r.record.meta.last_action, 'emailed the supplier');

  const h = await mem.history('agent');
  assert.deepStrictEqual(h.map(e => e.action),
    ['searched the catalogue', 'emailed the supplier']);
  assert.strictEqual(h[1].result.id, 'msg-8812', 'the result must survive for the next run');
});

await t('history is per task, not global', async () => {
  const root = store();
  const mem = new TaskMemory(new FileDriver(root));
  await mem.start('a'); await mem.start('b');
  await mem.advance('a', { action: 'a-one' });
  await mem.advance('b', { action: 'b-one' });
  assert.deepStrictEqual((await mem.history('a')).map(e => e.action), ['a-one']);
  assert.deepStrictEqual((await mem.history('b')).map(e => e.action), ['b-one']);
});

await t('a driver with no journal still checkpoints safely', async () => {
  // The position is what makes recovery correct; the journal only enriches it.
  const bare = {
    _s: new Map(),
    setState(k, v) { this._s.set(k, v); return true; },
    getState(k) { return this._s.get(k) ?? null; },
  };
  const mem = new TaskMemory(bare);
  await mem.start('t');
  await mem.advance('t', { action: 'did a thing' });
  assert.strictEqual((await mem.resume('t')).resumeFrom, 1);
  assert.deepStrictEqual(await mem.history('t'), []);
});

// ── crash capture, against a real process ──────────────────────────────────

function runWorker(root, taskId, mode, killAfterMs = null) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [WORKER, root, taskId, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => out += d);
    if (killAfterMs) setTimeout(() => child.kill('SIGTERM'), killAfterMs);
    child.on('close', (code, signal) => resolve({ out, code, signal }));
  });
}

await t('a terminated process survives with its progress intact', async () => {
  const root = store();
  const r = await runWorker(root, 'sigterm', 'slow', 900);
  assert.strictEqual(r.signal, 'SIGTERM', `expected SIGTERM, got ${r.code}/${r.signal}`);

  const mem = new TaskMemory(new FileDriver(root));
  const rec = await mem.get('sigterm');
  assert.ok(rec, 'progress written before each step must survive');
  assert.ok(rec.step >= 0);

  if (process.platform === 'win32') {
    // Windows has no POSIX signals: Node maps kill('SIGTERM') onto
    // TerminateProcess, so it lands like a SIGKILL and no handler runs. The
    // pre-step checkpoint is what saves the task, which is the design.
    console.log('      (win32: SIGTERM is uncatchable: pre-step checkpoint carried it)');
  } else {
    assert.match(rec.reason, /signal_SIGTERM/, 'POSIX must annotate the signal');
  }
});

await t('an uncaught exception is recorded with its message', async () => {
  const root = store();
  const r = await runWorker(root, 'boom', 'throw');
  assert.notStrictEqual(r.code, 0, 'the crash must still be a crash');

  const mem = new TaskMemory(new FileDriver(root));
  const rec = await mem.get('boom');
  assert.ok(rec, 'no record written');
  assert.match(rec.reason, /exception: step 2 exploded/);
  assert.strictEqual(rec.step, 1, 'the last survived step is what resumes');
});

await t('SIGKILL cannot be caught: the pre-step checkpoint is what saves it', async () => {
  const root = store();
  const child = spawn(process.execPath, [WORKER, root, 'hard', 'slow'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 900));
  child.kill('SIGKILL');
  await new Promise(r => child.on('close', r));

  const mem = new TaskMemory(new FileDriver(root));
  const rec = await mem.get('hard');
  // No handler ran, so there is no reason recorded, but the checkpoints
  // written before each step are still there, which is the whole design.
  assert.ok(rec, 'checkpoints written before the risk must survive a SIGKILL');
  assert.ok(rec.step >= 0);
  assert.ok(!rec.reason || !/signal/.test(rec.reason), 'SIGKILL leaves no reason behind');
});

await t('a killed worker resumes instead of restarting', async () => {
  const root = store();
  await runWorker(root, 'resume-me', 'slow', 900);
  const before = (await new TaskMemory(new FileDriver(root)).resume('resume-me')).resumeFrom;
  assert.ok(before > 0, 'expected progress before the kill');

  const r = await runWorker(root, 'resume-me', 'fast');
  assert.match(r.out, new RegExp(`resuming from ${before}`), r.out);
  const rec = await new TaskMemory(new FileDriver(root)).get('resume-me');
  assert.strictEqual(rec.state, 'DONE');
});

// ── pressure ───────────────────────────────────────────────────────────────

await t('memory pressure is a fraction, and the guard respects its threshold', async () => {
  const p = memoryPressure();
  assert.ok(p > 0 && p <= 1, `implausible pressure: ${p}`);

  const mem = fresh();
  await mem.start('t');
  assert.strictEqual(await checkpointIfPressured(mem, 't', 0, { threshold: 1.1 }), false);
  assert.strictEqual(await checkpointIfPressured(mem, 't', 0, { threshold: 0 }), true);
  assert.match((await mem.get('t')).reason, /memory_pressure:/);
});

await t('tasks can be enumerated on a driver that cannot walk keys', async () => {
  // Sibyl's HOT tier has set_state/get_state and no key listing at all, so the
  // index is the only way to answer "what tasks exist" there.
  const bare = {
    _s: new Map(),
    setState(k, v) { this._s.set(k, v); return true; },
    getState(k) { return this._s.get(k) ?? null; },
  };
  const mem = new TaskMemory(bare);
  await mem.start('one'); await mem.start('two');
  assert.deepStrictEqual(await mem.list(), ['one', 'two']);
  await mem.forget('one');
  assert.deepStrictEqual(await mem.list(), ['two']);
  assert.strictEqual(await mem.get('one'), null, 'a forgotten task must not resume');
});

await t('a forgotten task stays forgotten where state cannot be deleted', async () => {
  // Sibyl's HOT tier has no delete, so forget() overwrites with a marker. It
  // must not be `null`: the server coerces primitives to {value: null}, which
  // is truthy, and the task would read as alive with an empty record.
  const bare = {
    _s: new Map(),
    setState(k, v) { this._s.set(k, v); return true; },
    getState(k) { return this._s.get(k) ?? null; },
  };
  const mem = new TaskMemory(bare);
  await mem.start('gone', { steps: 3 });
  await mem.checkpoint('gone', 1);
  await mem.forget('gone');

  assert.strictEqual(await mem.get('gone'), null);
  assert.deepStrictEqual(await mem.resume('gone'),
    { found: false, state: null, step: 0, resumeFrom: 0, reason: null, record: null });

  // and starting again is a genuine fresh run, not a resurrection
  const again = await mem.start('gone', { steps: 3 });
  assert.strictEqual(again.state, 'STARTED');
  assert.strictEqual(again.step, 0);
});

await t('task ids are unique and shaped', async () => {
  const a = newTaskId(), b = newTaskId();
  assert.match(a, /^tk-\d+-[0-9a-f]{4}$/);
  assert.notStrictEqual(a, b);
});

for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch {} }
console.log(`\nPASS tasks.test: ${passed} groups green`);
