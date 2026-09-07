#!/usr/bin/env node
/**
 * A long job, built to be killed — the Task Checkpointing demo.
 *
 * Nine steps of a plausible pipeline. Each one is slow enough to be interrupted,
 * and each is checkpointed the moment it completes, which is before the next one
 * starts. Kill it anywhere and the next run continues from where it stopped.
 *
 * Usage: node tasks/demo-worker.mjs <taskId> [--hold <step>]
 * Env:   SIBYL_MEMORY_DB / AIRTIGHT_MEMORY / AIRTIGHT_STORE, AIRTIGHT_STEP_MS
 */
import { FileDriver } from '../memory/driver-file.mjs';
import { SibylDriver } from '../memory/driver-sibyl.mjs';
import { TaskMemory } from './checkpoint.mjs';
import { installCrashHooks, checkpointIfPressured } from './guard.mjs';

const STEPS = [
  'fetch source manifest',
  'download 1,842 records',
  'normalise field names',
  'deduplicate against existing',
  'enrich from third-party API',
  'validate against schema',
  'build search index',
  'write output shard',
  'publish manifest',
];

const args = process.argv.slice(2);
const taskId = args[0] || 'nightly-import';
const holdAt = args.includes('--hold') ? Number(args[args.indexOf('--hold') + 1]) : null;
const STEP_MS = Number(process.env.AIRTIGHT_STEP_MS || 1400);

const driver = process.env.AIRTIGHT_MEMORY === 'file'
  ? new FileDriver(process.env.AIRTIGHT_STORE || '.airtight-memory')
  : new SibylDriver({ bin: process.env.SIBYL_MCP_BIN || 'sibyl-memory-mcp', db: process.env.SIBYL_MEMORY_DB || null });

const mem = new TaskMemory(driver);
const say = s => process.stdout.write(s + '\n');
const wait = ms => new Promise(r => setTimeout(r, ms));

let done = -1;   // highest step completed, read by the crash hooks

try {
  // 1. Ask memory where we are BEFORE doing anything.
  const { found, resumeFrom, step, reason } = await mem.resume(taskId);
  await mem.start(taskId, { label: 'Nightly import', steps: STEPS.length });

  if (found && resumeFrom > 0) {
    done = step;
    say(`RESUMED at step ${resumeFrom} of ${STEPS.length}${reason ? ` · last stop: ${reason}` : ''}`);
    say(`SKIPPED ${resumeFrom} step${resumeFrom === 1 ? '' : 's'} already done`);
  } else {
    say(`START ${taskId} · ${STEPS.length} steps`);
  }

  // 2. Annotate the failures we can observe. Not the mechanism — see guard.mjs.
  installCrashHooks({ mem, taskId, step: () => (done >= 0 ? done : null) });

  for (let i = resumeFrom; i < STEPS.length; i++) {
    say(`STEP ${i} ${STEPS[i]}`);

    if (holdAt === i) {
      say(`HOLD at step ${i} — kill -9 ${process.pid}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }

    await wait(STEP_MS);                          // the risky part
    done = i;
    await mem.checkpoint(taskId, i);              // survivable the moment this lands
    say(`WROTE step ${i} complete`);

    // An OOM kill arrives as SIGKILL with no warning, so the only defence is
    // noticing the pressure while still running.
    await checkpointIfPressured(mem, taskId, i);
  }

  await mem.done(taskId);
  say(`DONE ${taskId}`);
} finally {
  driver.close?.();
}
