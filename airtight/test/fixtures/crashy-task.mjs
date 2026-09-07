/**
 * A worker built to be killed, for tasks.test.mjs.
 *
 * Runs a four-step job, checkpointing BEFORE each step begins, with crash hooks
 * installed. Modes: `slow` (waits, so a signal lands mid-run), `throw` (dies on
 * step 2), `fast` (runs to completion).
 *
 * Usage: node crashy-task.mjs <store> <taskId> <slow|throw|fast>
 */
import { FileDriver } from '../../memory/driver-file.mjs';
import { TaskMemory } from '../../tasks/checkpoint.mjs';
import { installCrashHooks } from '../../tasks/guard.mjs';

const [root, taskId, mode = 'fast'] = process.argv.slice(2);
const STEPS = 4;
const wait = ms => new Promise(r => setTimeout(r, ms));

const mem = new TaskMemory(new FileDriver(root));
let done = -1;                       // highest step completed

const { resumeFrom } = await mem.resume(taskId);
await mem.start(taskId, { label: 'crashy', steps: STEPS });
if (resumeFrom > 0) { done = resumeFrom - 1; console.log(`resuming from ${resumeFrom}`); }

installCrashHooks({ mem, taskId, step: () => (done >= 0 ? done : null) });

for (let i = resumeFrom; i < STEPS; i++) {
  if (mode === 'throw' && i === 2) throw new Error('step 2 exploded');
  if (mode === 'slow') await wait(600);          // long enough to be signalled
  done = i;
  await mem.checkpoint(taskId, i);               // survivable the moment it lands
  console.log(`step ${i} complete`);
}

await mem.done(taskId);
console.log('done');
process.exit(0);
