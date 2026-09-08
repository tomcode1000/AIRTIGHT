/**
 * AIRTIGHT: Task Checkpointing.
 *
 * The second module under the layer, independent of Payment Safety. Same
 * principle applied to progress instead of money: write before the risk, so a
 * process that dies knows how far it got.
 *
 * ── What Sibyl provides, and what this adds ─────────────────────────────────
 * Sibyl has three tiers and this module uses two of them for what they are for:
 *
 *   HOT   set_state/get_state: "ephemeral working state the agent updates
 *                               frequently · in-flight task list". One row per
 *                               key, overwritten. This is the task's POSITION.
 *   COLD  record_event: an append-only journal. This is WHAT WAS DONE.
 *
 * Sibyl gives you those places to put things. It does not give you the rules
 * that make a crash survivable, which is what this module is:
 *
 *   · the position is written BEFORE the next risky step, never after
 *   · a checkpoint may not rewind: rewinding is how work runs twice
 *   · a finished task refuses further checkpoints
 *   · start() is idempotent, so calling it on every boot is correct
 *   · resume() turns a stored position into "the next thing to do"
 *
 * The same relationship a write-ahead log has to fwrite: the value is the
 * ordering discipline and the guarantees, not the storage call underneath.
 *
 * ── Isolation ───────────────────────────────────────────────────────────────
 * State keys are namespaced `airtight:task:<id>` and journal events use the
 * kind `airtight-task`. Payment Safety uses entity categories (`airtight-deal`
 * and friends) and never touches state or the journal. Different tiers, so the
 * two modules cannot collide even by accident.
 */
import crypto from 'node:crypto';

/** HOT-tier key prefix. One state row per task. */
export const TASK_KEY = id => `airtight:task:${id}`;
/** COLD-tier journal kind. Append-only record of completed actions. */
export const TASK_EVENT = 'airtight-task';
/** Retained for tooling that lists categories; see `isolation` above. */
export const TASK_CAT = 'airtight-task';
/**
 * Index of known task ids.
 *
 * Sibyl's HOT tier is addressed by key and exposes no way to enumerate keys,
 * there is set_state and get_state and nothing else. Without an index a caller
 * could read any single task but never ask "what tasks exist", which the
 * operator surfaces need. One extra state row keeps that answer available on
 * every driver rather than only on the ones that can walk a directory.
 */
export const TASK_INDEX = 'airtight:task:index';

/**
 * Marker for a deleted task.
 *
 * Sibyl's HOT tier has set_state and get_state and no delete, so a forgotten
 * task has to be overwritten. It cannot be overwritten with `null`: the server
 * coerces a primitive body into `{value: <primitive>}`, so a null tombstone
 * comes back as a truthy object and every reader treats the task as alive with
 * an empty record. An explicit marker is unambiguous on any driver.
 */
const TOMBSTONE = { v: 1, deleted: true };
const isDeleted = rec => rec?.deleted === true;

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
   * @param driver  the same driver Payment Safety uses. Must provide the HOT
   *                tier (setState/getState); the journal is optional and the
   *                module degrades to position-only without it.
   */
  constructor(driver) {
    if (!driver?.setState || !driver?.getState) {
      throw new Error('TaskMemory: driver must support setState/getState (the HOT tier)');
    }
    this.driver = driver;
  }

  #now() { return new Date().toISOString(); }

  async get(taskId) {
    const rec = await this.driver.getState(TASK_KEY(taskId));
    return isDeleted(rec) ? null : rec;
  }
  async #put(taskId, rec) { await this.driver.setState(TASK_KEY(taskId), rec); return rec; }

  /** Every task id this store knows about. */
  async list() {
    const idx = await this.driver.getState(TASK_INDEX);
    return Array.isArray(idx?.ids) ? [...idx.ids].sort() : [];
  }

  async #index(taskId, present) {
    const idx = await this.driver.getState(TASK_INDEX);
    const ids = new Set(Array.isArray(idx?.ids) ? idx.ids : []);
    if (present) { if (ids.has(taskId)) return; ids.add(taskId); }
    else { if (!ids.delete(taskId)) return; }
    await this.driver.setState(TASK_INDEX, { v: 1, ids: [...ids] });
  }

  /**
   * Open a task. Returns the existing record untouched if one is already there,
   * so calling start() on every boot is safe and is the intended usage.
   */
  async start(taskId, { label = null, steps = null, meta = null } = {}) {
    // Index first, and for an existing record too: a task written before the
    // index existed would otherwise be readable but never enumerable, and the
    // repair has to happen on the path everyone already calls.
    await this.#index(taskId, true);

    const existing = await this.get(taskId);
    if (existing) return existing;

    return this.#put(taskId, {
      v: 1,
      task_id: taskId,
      state: 'STARTED',
      step: 0,
      total_steps: steps,          // null for an emergent agent. See advance()
      label,
      meta,
      reason: null,
      started_at: this.#now(),
      last_checkpoint_at: this.#now(),
    });
  }

  /**
   * Record that step N is complete. Call it BEFORE beginning step N+1: the
   * whole point is that the record exists before the risky work starts.
   *
   * The state row is overwritten, not appended: a task's checkpoint is its
   * current position, and a history would grow without bound on a long job.
   * When you need the history, that is what `advance()` and the journal are for.
   *
   * Steps may not move backwards. A checkpoint that would rewind is refused
   * rather than silently accepted, because rewinding is how work runs twice.
   */
  async checkpoint(taskId, step, { label = null, reason = null, meta = null } = {}) {
    const rec = await this.get(taskId);
    if (!rec) throw new Error(`checkpoint: no task record for ${taskId}. Call start() first`);
    if (rec.state === 'DONE') throw new Error(`checkpoint: task ${taskId} is already DONE`);
    if (!Number.isInteger(step) || step < 0) throw new Error('checkpoint: step must be a non-negative integer');
    if (step < rec.step) {
      throw new Error(`checkpoint: step ${step} is behind recorded step ${rec.step}: refusing to rewind`);
    }

    return this.#put(taskId, {
      ...rec,
      state: 'STEP',
      step,
      label: label ?? rec.label,
      meta: meta ?? rec.meta,
      reason,
      last_checkpoint_at: this.#now(),
    });
  }

  /**
   * For agents whose plan is not known in advance.
   *
   * A pipeline can say "step 5 of 9 done" and the code defines step 6. A ReAct
   * loop cannot: "5 actions done" tells the next run nothing about WHAT was
   * done, so it cannot tell whether an action needs repeating. This advances
   * the counter and appends what happened to the journal, so a resuming agent
   * can read its own history rather than infer it.
   *
   * @param action  short description of the completed action
   * @param result  optional payload: a cursor, an id, a summary
   */
  async advance(taskId, { action, result = null, reason = null } = {}) {
    const rec = await this.get(taskId);
    if (!rec) throw new Error(`advance: no task record for ${taskId}. Call start() first`);
    if (!action) throw new Error('advance: an action description is required');

    const step = rec.state === 'STARTED' ? 0 : rec.step + 1;
    const next = await this.checkpoint(taskId, step, {
      reason,
      meta: { ...(rec.meta ?? {}), last_action: action },
    });

    // Best effort: the journal enriches recovery but the position is what makes
    // it correct, so a driver without a journal is still safe.
    await this.driver.recordEvent?.(TASK_EVENT, { task_id: taskId, step, action, result, at: this.#now() });
    return next;
  }

  /** Completed actions in order, for an agent rebuilding what it already did. */
  async history(taskId) {
    const all = (await this.driver.readEvents?.(TASK_EVENT)) ?? [];
    return all.filter(e => e.body?.task_id === taskId).map(e => e.body);
  }

  async done(taskId, { meta = null } = {}) {
    const rec = await this.get(taskId);
    if (!rec) throw new Error(`done: no task record for ${taskId}`);
    return this.#put(taskId, { ...rec, state: 'DONE', reason: null, meta: meta ?? rec.meta, last_checkpoint_at: this.#now() });
  }

  /** Record why a task stopped. Terminal, but the step is preserved for resume. */
  async fail(taskId, reason) {
    const rec = await this.get(taskId);
    if (!rec) return null;
    return this.#put(taskId, { ...rec, state: 'FAILED', reason: String(reason).slice(0, 500), last_checkpoint_at: this.#now() });
  }

  /**
   * What a restarting process needs to know.
   *
   *   { found, state, step, resumeFrom, reason, record }
   *
   * `resumeFrom` is the next step to run. A task with no record resumes from 0
   * with found:false, which the caller must treat as "start over", and is
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

  async forget(taskId) {
    await this.#index(taskId, false);
    // Not every driver can delete a state row; overwrite with a tombstone so a
    // forgotten task cannot be resumed even where removal is unavailable.
    if (this.driver.removeState) return this.driver.removeState(TASK_KEY(taskId));
    await this.driver.setState(TASK_KEY(taskId), { ...TOMBSTONE });
    return true;
  }
}

export default { TaskMemory, TASK_KEY, TASK_EVENT, TASK_CAT, TASK_STATES, newTaskId, memoryPressure };
