# AIRTIGHT

**Write-before-risk memory for agents.** Two modules: an agent that cannot be
made to pay twice, and an agent that knows how far it got.

An autonomous agent that dies mid-purchase wakes up blind. Did it already pay?
A blind retry double-pays. Did the payment settle but the payload never arrive?
Paid, got nothing, no record. Disputed later? No provable terms, authorisation
or transaction proof.

AIRTIGHT gives a buying or selling agent a durable, verifiable record of its own
deals, so it can be killed at any instant and resume without paying twice.

```
INTENT → QUOTED → AUTHORIZED → IN_FLIGHT → PAID(tx) → DELIVERED(hash) → CLOSED
                                  ↘ (crash anywhere) ↖ resume-on-wake
                    PAID/DELIVERED/CLOSED --evidence--> DISPUTED (terminal)
```

## Install

Zero runtime dependencies. Node 22+.

```bash
npm install github:tomcode1000/AITIGHT       # while the repo is private, you need access
```

```js
import { TaskMemory }  from 'airtight/tasks';      // checkpointing only
import { DealMemory }  from 'airtight/payments';   // payment safety only
import { ... }         from 'airtight';            // both
```

Each subpath pulls in only its own module. Nothing runs in the background; it
is a library you call, not a daemon that watches your agent.

### The skill: teaching an agent when to call it

The library is what your agent calls. The skill is what tells it *when*, including
on wake, before it acts, which is the moment it has no reason to suspect a previous
run got halfway. Install it once:

```bash
npx airtight-skill              # this project  -> .claude/skills/airtight/
npx airtight-skill --global     # every project -> ~/.claude/skills/airtight/
```

It is a separate command rather than something `npm install` does silently, because
a dependency that writes into your `.claude` directory uninvited is doing something
you did not ask for. It prints what it wrote, is safe to run twice, and re-running it
after an upgrade picks up a newer skill.

One skill covers both modules, deliberately. The hard call for an agent is not
operating either one, it is choosing between them, and it can only make that choice
if both are described in the same place. The body carries that decision rule (*is
this step reversible?*), the call order, and the mistakes that cost money. Any
runtime that loads instruction files can use it; the format is standard skill
frontmatter, and the source is [`airtight/skill/SKILL.md`](airtight/skill/SKILL.md).

## Two modules, one principle

AIRTIGHT is a layer, not an application. The buyer agent in this repo is the
proof, not the product. It ships as two independent modules. Take either, or
both.

| | `airtight/payments` | `airtight/tasks` |
|---|---|---|
| **Protects** | money movement | task progress |
| **Writes before** | the payment is submitted | each risky step begins |
| **Records** | the signed authorisation + its nonce | the last completed step |
| **A missing record means** | **REFUSAL**: refuse to act | **start from zero** |
| **Sibyl tier** | entity records: `airtight-deal` `-fp` `-witness` `-att` | HOT state `airtight:task:*` + COLD journal |

Both apply the same rule: **write the thing that makes recovery possible before
taking the risk, never after.** They share the storage drivers and nothing else,
**different Sibyl tiers**, separate code paths, no cross-reads. Deleting every
task record leaves payments untouched, and the reverse.

Sibyl supplies the tiers. What these modules add is the part an API cannot: the
rule that the write comes *before* the action, the refusal to rewind, and the
decision about what a missing record means. The same relationship a write-ahead
log has to `fwrite`.

Which one you need turns on a single question: **is the step reversible?**

- **Irreversible**: money, an email, a delete. Use **Payment Safety**. A
  missing record must mean refusal, because starting over is how you pay twice.
- **Reversible but expensive**: a long import, a multi-stage build, a scrape.
  Use **Task Checkpointing**. Starting from zero is slow, not dangerous.

### Task Checkpointing

```js
import { TaskMemory, SibylDriver, installCrashHooks } from 'airtight/tasks';

const mem  = new TaskMemory(new SibylDriver());
const task = 'nightly-import';

let { resumeFrom } = await mem.resume(task);      // 0 on a first run
await mem.start(task, { label: 'Nightly import', steps: 4 });
installCrashHooks({ mem, taskId: task, step: () => resumeFrom - 1 });

for (let i = resumeFrom; i < 4; i++) {
  await doStep(i);                  // the risky part
  await mem.checkpoint(task, i);    // survivable the moment this lands
  resumeFrom = i + 1;
}
await mem.done(task);
```

Killed at any point, the next run reads `resumeFrom` and continues rather than
redoing everything. Steps cannot rewind: a checkpoint behind the recorded one
is refused, because rewinding is how work runs twice.

`installCrashHooks` annotates the failures a process can *observe* (SIGTERM,
SIGINT, uncaught exceptions, unhandled rejections) with a `reason` on the
record. It cannot catch SIGKILL, an OOM kill, or power loss, and **on Windows
no signal is catchable at all** (Node maps `kill('SIGTERM')` onto
`TerminateProcess`). That is precisely why the checkpoint goes *before* the step
and the hooks are only an annotation. They also re-raise what they caught: a
handler that recorded and swallowed would turn every crash into a clean exit 0.

### Payment Safety

```js
import {
  DealMemory, SibylDriver, signPayment, headerFromStored,
  assessDeal, mayTransfer, submitPayment,
} from 'airtight';

const mem = new DealMemory(new SibylDriver());

// 1. On wake, ask what you are allowed to do. Never assume.
const prior = await mem.get(dealId);
if (prior) {
  const v = assessDeal({ deal: prior, attestations: await mem.getAttestations(dealId) });
  if (v.verdict !== 'RESUME') return;        // REFUSAL, or DISPUTED with evidence
}

// 2. Commit to the terms before signing anything.
const deal = await mem.open({ role: 'buyer', terms });

// 3. Sign → store → THEN pay. This order is the product.
const signed = signPayment({ privateKey, requirements });
if (!await mem.claimFingerprint(signed.fingerprint, deal.deal_id)) return;   // would double-pay
await mem.transition(deal.deal_id, 'IN_FLIGHT', {
  payment: { fingerprint: signed.fingerprint, x402: signed.stored },
});
await submitPayment(url, signed.header);
```

Killed anywhere above, the next run resumes and re-submits
`headerFromStored(deal.payment.x402)`: the **same** EIP-3009 nonce, which the
token contract honours exactly once. Signing a fresh one instead is the
double-pay.

`transition()` refuses to record a state whose evidence is missing, so the
action it guards never happens. That is what makes the memory load-bearing
rather than advisory.

## Features, and where they live

Every one of these stores its state in Sibyl Memory. The Sibyl category each
writes is named, so you can verify with `sibyl memory list` rather than trust
this table.

| Feature | Sibyl category | Code |
|---|---|---|
| **Deal state machine**: write-before-act; a state cannot be entered without its evidence | `airtight-deal` | [memory/deals.mjs](airtight/memory/deals.mjs) |
| **Payment replay guard**: fingerprints claimed *before* signing, persisted across restarts | `airtight-fp` | [memory/deals.mjs](airtight/memory/deals.mjs) |
| **Idempotent payment**: the signed EIP-3009 authorisation stored before submitting, re-submitted on wake | `airtight-deal` (`payment.x402`) | [x402/pay.mjs](airtight/x402/pay.mjs) |
| **Resume-on-wake / refuse-blind**: decides RESUME, REFUSAL or DISPUTED from storage alone | reads all | [resume.mjs](airtight/staging/selective_disclosure/resume.mjs) |
| **Delivery notarisation**: the seller signs what it delivered, under a domain disjoint from USDC's | `airtight-att` | [notary.mjs](airtight/staging/selective_disclosure/notary.mjs) |
| **Selective disclosure**: commit to terms, reveal chosen fields with proofs; blinding nonces held apart from the shareable record | `airtight-witness` | [merkle.js](airtight/staging/selective_disclosure/merkle.js) |
| **Recall surface**: a cold process reading only what reached storage | reads all | [cli.mjs](airtight/cli.mjs) |
| **Task checkpointing**: position written before each step; resume instead of restart | HOT state `airtight:task:*` | [tasks/checkpoint.mjs](airtight/tasks/checkpoint.mjs) |
| **Action history**: what was done, for agents whose plan is not known in advance | COLD journal `airtight-task` | [tasks/checkpoint.mjs](airtight/tasks/checkpoint.mjs) |
| **Crash capture**: SIGTERM/SIGINT/exception annotated onto the record, then re-raised | HOT state | [tasks/guard.mjs](airtight/tasks/guard.mjs) |

A live deal writes all four categories:

```
$ sibyl memory list
E N T I T I E S   ( 4 )
  airtight-deal/att-1
  airtight-att/4662c672…47cc:delivery
  airtight-fp/4662c672…47cc
  airtight-witness/att-1
```

## Where memory is load-bearing

Delete the memory and the product stops working; that is the design, not a
side effect. Three places to look, none more than a file away:

| What | Where |
|---|---|
| Every record written and read; state rules enforced at the write | [`airtight/memory/deals.mjs`](airtight/memory/deals.mjs) |
| What a woken agent is allowed to do, read from storage alone | [`airtight/staging/selective_disclosure/resume.mjs`](airtight/staging/selective_disclosure/resume.mjs) |
| Crash-safe durability (fsync → atomic rename → fsync dir) | [`airtight/memory/driver-file.mjs`](airtight/memory/driver-file.mjs) |

Five rules make it load-bearing:

1. **Write-before-act**: a state cannot be entered without its evidence
   durably recorded. `transition()` refuses the write, so the action never
   happens. This is data, not discipline: see `EVIDENCE` in `deals.mjs`.
2. **Hash-verified**: `terms_hash` must recompute on every wake; payload
   integrity is checked against a recorded sha256. Prose can be hallucinated,
   hashes cannot.
3. **PAID gates transfer**: payment fingerprints are claimed *before* signing
   and persist across restarts. The ported x402 code admits its replay map is
   "in-memory: restart clears it"; that admission is the gap this closes.
4. **Resume-on-wake**: a cold process reads the last verified state and
   continues exactly there. `IN_FLIGHT` resumes by reconciling, never by
   re-signing.
5. **Refuse-blind**: missing or corrupt memory produces a REFUSAL. The agent
   acts on nothing rather than guessing.

## Proof it works

```bash
cd airtight && npm test      # 86 groups across 5 suites
npm run chaos                # SIGKILL a real process at every boundary
```

The chaos suite spawns an actual buyer process, `SIGKILL`s it the moment it
reaches each boundary, then spawns a fresh one over the same store. The
settlement ledger is the assertion: **exactly one settlement, wherever the kill
landed**:

```
ok  kill at AT:INTENT      → resumed at INTENT     · 1 settlement · CLOSED
ok  kill at AT:QUOTED      → resumed at QUOTED     · 1 settlement · CLOSED
ok  kill at AT:AUTHORIZED  → resumed at AUTHORIZED · 1 settlement · CLOSED
ok  kill at AT:IN_FLIGHT   → resumed at IN_FLIGHT  · 1 settlement · CLOSED
ok  kill at AT:SETTLED     → resumed at IN_FLIGHT  · 1 settlement · CLOSED
ok  kill at AT:PAID        → resumed at PAID       · 1 settlement · CLOSED
ok  kill at AT:DELIVERED   → resumed at DELIVERED  · 1 settlement · CLOSED
ok  memory deleted         → no unverified settlement
```

The two middle rows are the whole argument. Killed *before* settlement,
reconciliation finds nothing and re-submits **the same** authorisation: the
EIP-3009 nonce is fixed, so the token contract honours it exactly once and the
retry is idempotent. Killed *after* settlement but before the `PAID` write,
reconciliation finds it and does not re-settle. Signing a *fresh* nonce in the
first case is the double-pay, and the difference between those two paths is
exactly what [x402 issue #452](https://github.com/coinbase/x402/issues/452)
leaves undefined.

## Proving a deal to someone else

Beyond surviving its own death, an agent can prove a *specific fact* about a
deal without revealing the rest of it.

- **Selective disclosure** ([`merkle.js`](airtight/staging/selective_disclosure/merkle.js)),
  commit a Merkle root over the terms at deal time, reveal chosen fields
  later with proofs. Leaves are blinded with 128-bit nonces: without them a
  low-entropy field like a price is brute-forceable straight out of its hash.
  Nonces live in a separate `airtight-witness` record, never in the shareable
  deal record.
- **Notarisation** ([`notary.mjs`](airtight/staging/selective_disclosure/notary.mjs)),
  sign a prompt, result or delivered payload with the *same key that pays*,
  so an adjudicator can tie it to the on-chain payer address. Signed under a
  domain deliberately disjoint from USDC's EIP-3009 domain, so an attestation
  can never be replayed as a transfer authorisation. Tested both directions.

Together these decide DISPUTED vs REFUSAL, under one rule: **you can only
dispute what someone signed.** A valid counterparty signature contradicted by
reality is evidence a third party can act on. Anything unverifiable is
indistinguishable from our own memory being corrupted, so it fails closed. If
unverifiable state escalated to DISPUTED, anyone who could corrupt our memory
could manufacture disputes against honest sellers.

## Real settlement, verified on-chain

Base Sepolia, live: tx
[`0x47f84e28…dd0221`](https://sepolia.basescan.org/tx/0x47f84e28df3686e27620ddac3ec1d2bccfc84bbe0dfb37938d8186ac24dd0221):

```
$ npm run onchain deal-live-1
tx status    : SUCCESS   block 46418924
transfer     : 0x2f2ffb…30b1cf → 0x1957a9…12e341  0.01 USDC
agreed terms : recipient ✓  amount ✓
gas paid by  : 0xd407e4…e7f1bf  (facilitator: the buyer holds no ETH)
nonce stored : 0x9c7f38e25b964a4da6fabdb0297b37b427bd7c3674caf274f9d097b3b041e62e
nonce burned : 0x9c7f38e25b964a4da6fabdb0297b37b427bd7c3674caf274f9d097b3b041e62e
MATCH        : YES; this payment can never be repeated
```

The last two lines are the argument in full. The EIP-3009 nonce AIRTIGHT wrote
to memory **before** paying is exactly the nonce the USDC contract burned. That
nonce is the only thing making the payment unrepeatable, so a woken agent must
re-submit the authorisation it stored rather than sign a fresh one. Delete the
memory layer and there is nothing to re-submit: the only remaining options are
to double-pay or to never retry.

## Setup

Requires Node 22+. Python 3.10+ only if you want the Sibyl substrate.

```bash
git clone <repo> && cd airtight/airtight
npm test                    # no install step: zero runtime dependencies
```

The test suite runs everything, including a real 402 exchange over HTTP against
a locally spawned seller. No keys, funds, or network access are needed: the
facilitator is mocked, nothing else is.

**To run against Sibyl Memory** (the real substrate):

```bash
python -m venv ../.venv
../.venv/Scripts/pip install 'sibyl-memory-cli[mcp]'   # .venv/bin/pip on Linux/macOS
../.venv/Scripts/sibyl init                            # browser sign-in
npm run test:sibyl
```

**To run a live deal on Base Sepolia:**

```bash
npm run burner >> ../.env        # generates throwaway wallets, prints the address to fund
# fund the printed buyer address with Base Sepolia USDC (faucet.circle.com)
# USDC only: no ETH; the facilitator pays gas

set -a; source ../.env; set +a
unset PAYMENT_MODE               # mock off

node seller/server.mjs 4021                                   # terminal 1
node buyer/agent.mjs http://localhost:4021/report/42 deal-1   # terminal 2
npm run onchain deal-1                                        # verify against the chain
```

Then inspect what the agent remembers:

```bash
node cli.mjs ls
node cli.mjs recall deal-1
```

`AIRTIGHT_MEMORY=file` selects the local test driver; the default is Sibyl.

## Status

Working and tested: the Sibyl Memory driver, deal memory and state machine, the
crash-safe local driver, resume assessment, selective disclosure, notarisation,
a live x402 buyer and seller, and two SIGKILL suites: one over a mock ledger,
one over the real protocol.

Not yet done: the replay UI.

## Prior work

- **`acquisition-agent`** (author's own, pre-window): the x402 client/server,
  EIP-3009 signer and 402 gate are ported from it, as inventoried in
  [PORTING.md](airtight/PORTING.md). `signer.mjs` gains two AIRTIGHT-authored
  exports (`recoverAddress`, `addressFromPubkey`); everything else in
  `airtight/staging/x402/` is prior work.
- **AUTOPSY**: sibling project by the same author.
- Inspiration and credit: **Internet Court** (third-party adjudication after a
  deal breaks) and **Fortytwo x402Escrow** (on-chain custody of funds
  mid-flight). AIRTIGHT is complementary and sits at a different layer: the
  agent's own deal state, client-side. Protocol gaps cited: x402 issues #452
  and #2887.

## Licence

MIT. See [LICENSE](LICENSE).
