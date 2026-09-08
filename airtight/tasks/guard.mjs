/**
 * Crash capture for Task Checkpointing.
 *
 * Writes a checkpoint on the way out for the failures a process can observe:
 * SIGTERM, SIGINT, an uncaught exception, an unhandled rejection.
 *
 * ── What this cannot do, and why it does not matter much ────────────────────
 * SIGKILL, `kill -9`, a pulled plug and an OOM-killer kill are all unobservable,
 * the process simply stops. So these handlers are a convenience, not the
 * mechanism. Correctness comes from `checkpoint()` being called BEFORE each
 * risky step; the handlers only add a `reason` for the cases where the process
 * got a moment to speak.
 *
 * A handler runs at a bad time by definition, so it must be small: one write,
 * a short deadline, and then get out of the way. Exit codes are preserved and
 * signals are re-raised so supervisors still see what actually happened.
 *
 * ── Windows ─────────────────────────────────────────────────────────────────
 * Windows has no POSIX signals. Node maps child.kill('SIGTERM') onto
 * TerminateProcess, which is unconditional, so a SIGTERM there behaves exactly
 * like a SIGKILL and no handler runs. Exceptions and unhandled rejections are
 * still captured normally. This is another reason the pre-step checkpoint is
 * the mechanism and these hooks are only an annotation.
 */
import { memoryPressure } from './checkpoint.mjs';

const DEFAULT_DEADLINE_MS = 1500;

/**
 * @param mem       a TaskMemory
 * @param taskId    the task to annotate
 * @param step      () => number: the step reached so far, read at crash time
 * @param deadline  ms to allow the final write before exiting anyway
 * @returns { dispose() }: remove the handlers again
 */
export function installCrashHooks({ mem, taskId, step = () => null, deadline = DEFAULT_DEADLINE_MS, onWrite = null } = {}) {
  if (!mem || !taskId) throw new Error('installCrashHooks: mem and taskId are required');

  let firing = false;

  async function record(reason) {
    if (firing) return;              // one write, whatever else arrives
    firing = true;
    const write = (async () => {
      const s = step();
      if (Number.isInteger(s)) await mem.checkpoint(taskId, s, { reason });
      else await mem.fail(taskId, reason);
      onWrite?.(reason);
    })().catch(() => {});
    // Never let a hanging store keep a dying process alive.
    await Promise.race([write, new Promise(r => setTimeout(r, deadline))]);
  }

  const onSignal = sig => async () => {
    await record(`signal_${sig}`);
    process.removeListener(sig, handlers[sig]);
    process.kill(process.pid, sig);   // re-raise so the exit status is honest
  };

  const handlers = {
    SIGTERM: onSignal('SIGTERM'),
    SIGINT: onSignal('SIGINT'),
  };
  process.on('SIGTERM', handlers.SIGTERM);
  process.on('SIGINT', handlers.SIGINT);

  /**
   * Put the crash back exactly as it was.
   *
   * Registering an uncaughtException listener suppresses Node's default
   * behaviour, so a hook that merely records would convert every crash into a
   * clean exit 0: the failure would vanish from logs, exit codes and
   * supervisors. Re-throwing from inside the async handler does not help
   * either: that becomes another rejection, which this same hook then swallows.
   *
   * Removing both listeners first and re-throwing on the next tick means the
   * error reaches Node with no handler installed, which is what produces the
   * original stack trace and non-zero exit.
   */
  const rethrow = err => {
    process.removeListener('uncaughtException', onException);
    process.removeListener('unhandledRejection', onRejection);
    process.nextTick(() => { throw err; });
  };

  const onException = async err => {
    await record(`exception: ${err?.message ?? String(err)}`);
    rethrow(err);
  };
  const onRejection = async reason => {
    await record(`unhandled_rejection: ${reason?.message ?? String(reason)}`);
    rethrow(reason instanceof Error ? reason : new Error(String(reason)));
  };
  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);

  return {
    dispose() {
      process.removeListener('SIGTERM', handlers.SIGTERM);
      process.removeListener('SIGINT', handlers.SIGINT);
      process.removeListener('uncaughtException', onException);
      process.removeListener('unhandledRejection', onRejection);
    },
  };
}

/**
 * Optional pre-emptive checkpoint, called at a boundary you already reached.
 *
 * An OOM kill arrives as SIGKILL with no warning, so the only defence is to
 * notice the pressure while still running. Returns true if it wrote.
 */
export async function checkpointIfPressured(mem, taskId, step, { threshold = 0.85, reason = 'memory_pressure' } = {}) {
  const used = memoryPressure();
  if (used < threshold) return false;
  await mem.checkpoint(taskId, step, { reason: `${reason}:${used.toFixed(2)}` });
  return true;
}

export default { installCrashHooks, checkpointIfPressured };
