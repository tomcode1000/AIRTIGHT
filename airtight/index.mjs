/**
 * AIRTIGHT — write-before-risk memory for agents.
 *
 * Two independent modules under one layer. Take either, or both.
 *
 *   airtight/payments   Payment Safety      an agent that cannot pay twice
 *   airtight/tasks      Task Checkpointing  an agent that knows how far it got
 *
 * They share one principle: record the thing that makes recovery possible
 * BEFORE taking the risk, never after. They share the storage drivers. They
 * share nothing else — separate Sibyl categories, separate code paths, no
 * cross-reads. Removing one does not affect the other.
 *
 *   Payment Safety     airtight-deal · airtight-fp · airtight-witness · airtight-att
 *   Task Checkpointing airtight-task
 *
 * Which one you want:
 *
 *   Is the step irreversible — money, an email, a delete?   → Payment Safety.
 *     A missing record must mean REFUSAL, not "start over".
 *
 *   Is the step safe to repeat but expensive to repeat?     → Task Checkpointing.
 *     A missing record means starting from zero, which is slow, not dangerous.
 *
 * Importing from the root gives you both. Importing from a subpath gives you
 * one, and pulls in nothing from the other.
 */

export * from './payments.mjs';
export {
  TaskMemory, TASK_CAT, TASK_STATES, newTaskId, memoryPressure,
  installCrashHooks, checkpointIfPressured,
} from './tasks/index.mjs';
