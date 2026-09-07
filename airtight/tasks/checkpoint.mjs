/**
 * AIRTIGHT — Task Checkpointing.
 *
 * The second module under the layer, independent of Payment Safety. Same
 * principle applied to progress instead of money: write before the risk, so a
 * process that dies knows how far it got.
 *
 * ── Isolation ───────────────────────────────────────────────────────────────
 * Task records live in their own Sibyl category, `airtight-task`. Payment
 * records live in `airtight-deal` / `-fp` / `-witness` / `-att`. Nothing here
 * reads or writes a payment category, and nothing in Payment Safety touches
 * this one. Category is the substrate's own isolation unit, which is stronger
 * than a naming convention inside a shared namespace: a bug cannot silently
 * address the wrong record by building a key wrong.
 *
 * ── Why checkpoints go BEFORE the risky step ────────────────────────────────
 * SIGKILL and power loss cannot be caught. Any design that only writes from a
 * crash handler loses exactly the crashes that matter most. The handlers below
 * are a convenience for the catchable cases; correctness comes from
 * checkpointing before the step, not from detecting the failure.
 */
import crypto from 'node:crypto';

export const TASK_CAT = 'airtight-task';

/** STARTED → STEP (repeatable) → DONE, or FAILED from anywhere. */
export const TASK_STATES = Object.freeze(['STARTED', 'STEP', 'DONE', 'FAILED']);

export function newTaskId(prefix = 'tk') {
  return `${prefix}-${Math.floor(Date.now() / 1000)}-${crypto.randomBytes(2).toString('hex')}`;
}

/** Fraction of the heap in use, for the optional pressure check. */
export function memoryPressure() {
  const { heapUsed, heapTotal } = process.memoryUsage();
  return heapTotal ? heapUsed / heapTotal : 0;
}

export class TaskMemory {
  /**
   * @param driver  the same driver Payment Safety uses (SibylDriver / FileDriver).
   *                Sharing a driver is fine; the categories keep the data apart.
   */
  constructor(driver) {
    if (!driver?.write) throw new Error('TaskMemory: a driver is required');
    this.driver = driver;
  }

  #now() { return new Date().toISOString(); }

  async get(taskId) { return this.driver.read(TASK_CAT, taskId); }
  async list() { return this.driver.list(TASK_CAT); }

  /**
   * Open a task. Returns the existing record untouched if one is already there,
   * so calling start() on every boot is safe and is the intended usage.
   */
  async start(taskId, { label = null, steps = null, meta = null } = {}) {
    const existing = await this.get(taskId);
    if (existing) return existing;

    const rec = {
      v: 1,
      task_id: taskId,
      state: 'STARTED',
      step: 0,
      total_steps: steps,
      label,
      meta,
      reason: null,
      started_at: this.#now(),
      last_checkpoint_at: this.#now(),
    };
    await this.driver.write(TASK_CAT, taskId, rec);
    return rec;
  }

  /**
   * Record that step N is complete. Call it BEFORE beginning step N+1 — the
   * whole point is that the record exists before the risky work starts.
   *
   * The record is overwritten, not appended: a task's checkpoint is its current
   * position, and keeping a history would grow without bound for long jobs.
   *
   * Steps may not move backwards. A checkpoint that would rewind is refused
   * rather than silently accepted, because rewinding is how re-execution
   * happens twice.
   */
  async checkpoint(taskId, step, { label = null, reason = null, meta = null } = {}) {
    const rec = await this.get(taskId);
    if (!rec) throw new Error(`checkpoint: no task record for ${taskId} — call start() first`);
    if (rec.state === 'DONE') throw new Error(`checkpoint: task ${taskId} is already DONE`);
    if (!Number.isInteger(step) || step < 0) throw new Error('checkpoint: step must be a non-negative integer');
    if (step < rec.step) {
      throw new Error(`checkpoint: step ${step} is behind recorded step ${rec.step} — refusing to rewind`);
    }

    const next = {
      ...rec,
      state: 'STEP',
      step,
      label: label ?? rec.label,
      meta: meta ?? rec.meta,
      reason,
      last_checkpoint_at: this.#now(),
    };
    await this.driver.write(TASK_CAT, taskId, next);
    return next;
  }

  async done(taskId, { meta = null } = {}) {
    const rec = await this.get(taskId);
    if (!rec) throw new Error(`done: no task record for ${taskId}`);
    const next = { ...rec, state: 'DONE', reason: null, meta: meta ?? rec.meta, last_checkpoint_at: this.#now() };
    await this.driver.write(TASK_CAT, taskId, next);
    return next;
  }

  /** Record why a task stopped. Terminal, but the step is preserved for resume. */
  async fail(taskId, reason) {
    const rec = await this.get(taskId);
    if (!rec) return null;
    const next = { ...rec, state: 'FAILED', reason: String(reason).slice(0, 500), last_checkpoint_at: this.#now() };
    await this.driver.write(TASK_CAT, taskId, next);
    return next;
  }

  /**
   * What a restarting process needs to know.
   *
   *   { found, state, step, resumeFrom, reason, record }
   *
   * `resumeFrom` is the next step to run. A task with no record resumes from 0
   * with found:false — which the caller must treat as "start over", and is
   * exactly why anything irreversible belongs behind Payment Safety instead.
   */
  async resume(taskId) {
    const rec = await this.get(taskId);
    if (!rec) return { found: false, state: null, step: 0, resumeFrom: 0, reason: null, record: null };
    if (rec.v !== 1) {
      return { found: false, state: null, step: 0, resumeFrom: 0, reason: `unsupported record version ${rec.v}`, record: null };
    }
    return {
      found: true,
      state: rec.state,
      step: rec.step,
      resumeFrom: rec.state === 'DONE' ? rec.step : rec.step + (rec.state === 'STARTED' ? 0 : 1),
      reason: rec.reason,
      record: rec,
    };
  }

  async forget(taskId) { return this.driver.remove?.(TASK_CAT, taskId) ?? false; }
}

export default { TaskMemory, TASK_CAT, TASK_STATES, newTaskId, memoryPressure };
