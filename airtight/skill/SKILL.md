---
name: airtight
description: Use BEFORE any step that is expensive or impossible to repeat, such as moving money, sending a message, deleting data, or beginning a long multi-step job. Records what is needed to recover before the risk is taken, so a crashed or restarted agent resumes instead of redoing work or paying twice. Also use on WAKE, before acting, to find out what a previous run already did. Triggers: "pay", "transfer", "purchase", "x402", "settle", "checkout", "long job", "batch", "import", "migration", "pipeline", "resume", "restart", "crashed", "picked up where I left off".
---

# AIRTIGHT: write before the risk

You are an agent that can be killed at any moment: a deploy, an OOM, a dropped
socket, a `kill -9`. None of those give you a warning. AIRTIGHT is how you make
that survivable; **you record what recovery needs BEFORE you take the risk,
never after**, so it does not matter when the process stops.

There are two modules. Pick by one question: **is the step reversible?**

| The step | Module | A missing record means |
|---|---|---|
| Irreversible: money, an email, a delete | `airtight/payments` | **REFUSE to act** |
| Reversible but expensive: a long job | `airtight/tasks` | start from zero |

If you get this wrong in the direction of tasks, an agent pays twice. Prefer
Payment Safety whenever you are unsure.

---

## Rule 1: on wake, ask before you act

Never assume a fresh start. A previous run of you may have got halfway.

```js
import { DealMemory, SibylDriver, assessDeal } from 'airtight/payments';
const mem = new DealMemory(new SibylDriver());

const deal = await mem.get(dealId);
if (deal) {
  const v = assessDeal({ deal, attestations: await mem.getAttestations(dealId) });
  if (v.verdict !== 'RESUME') return;      // REFUSAL, or DISPUTED with evidence
  // v.action tells you the one next thing to do
}
```

`assessDeal` returns exactly one of:

- **RESUME**: safe to continue, and `action` says from where
- **REFUSAL**: you cannot verify your own state. **Stop. Do not start over.**
  Starting over is how you pay twice.
- **DISPUTED**: a counterparty signed for something that did not happen.
  You hold portable evidence; do not retry, escalate.

## Rule 2: before money moves, store the instrument

The order is the entire product. Sign, **store**, then pay.

```js
import { signPayment, headerFromStored, submitPayment } from 'airtight/payments';

const signed = signPayment({ privateKey, requirements });     // 1. sign
if (!await mem.claimFingerprint(signed.fingerprint, dealId)) return;  // would double-pay
await mem.transition(dealId, 'IN_FLIGHT', {                   // 2. STORE
  payment: { fingerprint: signed.fingerprint, x402: signed.stored },
});
await submitPayment(url, signed.header);                      // 3. only now, pay
```

Killed between 2 and 3? On the next run, re-submit **what you stored**:

```js
await submitPayment(url, headerFromStored(deal.payment.x402));
```

Never sign a fresh authorisation on resume. The nonce is what makes a payment
unrepeatable: the same one settles at most once, a new one pays again.

## Rule 3: before a long job, checkpoint each step

```js
import { TaskMemory, SibylDriver, installCrashHooks } from 'airtight/tasks';
const mem = new TaskMemory(new SibylDriver());

let { resumeFrom } = await mem.resume(taskId);        // 0 on a first run
await mem.start(taskId, { label: 'Nightly import', steps: 9 });
installCrashHooks({ mem, taskId, step: () => resumeFrom - 1 });

for (let i = resumeFrom; i < 9; i++) {
  await doStep(i);                  // the risky part
  await mem.checkpoint(taskId, i);  // survivable the moment this lands
  resumeFrom = i + 1;
}
await mem.done(taskId);
```

**When your plan is not known in advance**: a loop deciding its next action
from the last result. Use `advance()` instead. A counter alone cannot tell a
future run *what* was done:

```js
await mem.advance(taskId, { action: 'emailed the supplier', result: { id: 'msg-8812' } });
const alreadyDone = await mem.history(taskId);   // on the next run, read it back
```

---

## When NOT to use this

- **A single LLM call with no steps.** Nothing to checkpoint; adding it is noise.
- **Work that is cheap to repeat.** A checkpoint costs a write. If redoing the
  step is free, skip it.
- **As a substitute for context.** Checkpointing restores your *position*, not
  your reasoning. You will know not to redo step 5; you will not get your
  context window back.

## Things that will bite you

- **`checkpoint()` before starting the next step, not after finishing the last
  thought.** A record written after the risk protects nothing.
- **Checkpoints cannot rewind.** Writing a step behind the recorded one is
  refused, because rewinding is how work runs twice.
- **Crash hooks are an annotation, not the mechanism.** SIGKILL, OOM kills and
  power loss cannot be caught, and on Windows no signal can. The pre-step write
  is what saves you.
- **A missing task record means start from zero.** That is fine for a scrape and
  catastrophic for a payment. If the step moves money, it belongs in
  `airtight/payments`, where a missing record means refuse.

## Install

```bash
npm install github:tomcode1000/AITIGHT
```

Zero dependencies, Node 22+. `airtight/payments` and `airtight/tasks` install
independently; importing one pulls in nothing from the other.
