/**
 * AIRTIGHT / Task Checkpointing — a crashed agent knows how far it got.
 *
 *   import { TaskMemory, SibylDriver, installCrashHooks } from 'airtight/tasks';
 *
 *   const mem  = new TaskMemory(new SibylDriver());
 *   const task = 'nightly-import';
 *   let { resumeFrom } = await mem.resume(task);      // 0 on a first run
 *   await mem.start(task, { label: 'Nightly import', steps: 4 });
 *
 *   installCrashHooks({ mem, taskId: task, step: () => resumeFrom });
 *
 *   for (let i = resumeFrom; i < 4; i++) {
 *     await doStep(i);                 // the risky part
 *     await mem.checkpoint(task, i);   // written the moment it is survivable
 *     resumeFrom = i + 1;
 *   }
 *   await mem.done(task);
 *
 * Independent of Payment Safety: separate records, separate category, no shared
 * code path. Install either, or both.
 *
 * Use this for work that is safe to repeat but expensive to repeat. Anything
 * irreversible — money, an email, a delete — belongs behind Payment Safety
 * instead, because a task with no record resumes from zero by design.
 */
export { TaskMemory, TASK_KEY, TASK_EVENT, TASK_INDEX, TASK_CAT, TASK_STATES, newTaskId, memoryPressure } from './checkpoint.mjs';
export { installCrashHooks, checkpointIfPressured } from './guard.mjs';

// The storage drivers are shared with Payment Safety; the categories keep the
// two sets of records apart.
export { SibylDriver } from '../memory/driver-sibyl.mjs';
export { FileDriver } from '../memory/driver-file.mjs';
