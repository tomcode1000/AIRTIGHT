# AIRTIGHT — Record Schema

Two independent modules share one substrate and one principle: write the thing
that makes recovery possible BEFORE taking the risk.

| Module | Categories | Missing record means |
|---|---|---|
| **Payment Safety** | `airtight-deal` · `airtight-fp` · `airtight-witness` · `airtight-att` | **REFUSAL** — never "start over", because starting over is how you pay twice |
| **Task Checkpointing** | `airtight-task` | **start from zero** — slow, not dangerous |

Isolation is by Sibyl *category*, not by a prefix inside a shared name. Category
is the substrate's own boundary, so a key built wrong cannot silently address
the other module's records. Neither module reads or writes the other's
categories; removing one leaves the other intact.

---

# Payment Safety — Deal Record Schema v1 (locked Aug 25, pre-window)

Storage substrate: Sibyl Memory MCP (`memory_remember/recall/search/list`).
Verified shapes from spikes: `memory_remember{category, name, body}` · structured
dict bodies round-trip intact across processes · works pre-activation.

## Entities

### 1. Deal record
- **category:** `airtight-deal`
- **name:** `<deal_id>` = `dt-<unix_ts>-<4 hex>`
- **body** (dict):

```
{
  "v": 1,
  "role": "buyer" | "seller",
  "state": "INTENT|QUOTED|AUTHORIZED|IN_FLIGHT|PAID|DELIVERED|CLOSED|DISPUTED",
  "terms": {
    "resource_url": "...",
    "seller": "0x...",
    "pay_to": "0x...",
    "network": "base-sepolia" | "base",
    "asset": "0x<USDC>",
    "price_cap_usdc": 0.01,
    "max_amount_required": "10000"   # raw units, from 402 challenge
  },
  "terms_hash": "sha256(canonical_json(terms))",
  "authorization": { "payer": "0x...", "authorized_at": <iso> },  # NO KEYS EVER
  "payment": {
    "fingerprint": "sha256(resource|nonce|amount|payTo)",           # replay guard
    "tx_hash": "0x...",                                            # set at PAID
    "settled_at": <iso>
  },
  "delivery": { "payload_sha256": "0x...", "received_at": <iso>, "bytes": N },
  "transitions": [ {"to":"INTENT","at":<iso>}, ... ],               # append-only
  "disclosure": { "merkle_root": "hex", "fields": ["created_at","price_usdc",...] },  # committed field NAMES only
  "created_at": <iso>, "updated_at": <iso>
}
```

### 2. Consumed-payment fingerprint (replay guard)
- **category:** `airtight-fp`
- **name:** `<fingerprint>` (the sha256 above)
- **body:** `{"deal_id": ..., "consumed_at": <iso>}`
- Lookup is O(1) by exact name via `memory_recall` — replaces acquisition-agent's
  in-memory Map ("restart clears it" admission = our thesis proof).

### 3. Disclosure witness (private — never shared)
- **category:** `airtight-witness`
- **name:** `<deal_id>`
- **body:** `{"v":1, "root":"hex", "fields":[{"key":..., "value":..., "nonce":"32 hex"}]}`
- Holds the per-field blinding nonces. Splitting these out of the deal record is
  deliberate: the deal record can be shown to a counterparty, the witness cannot.
  Leaking a nonce makes that field brute-forceable from its leaf hash.
- Lost witness ⇒ the root still verifies past disclosures, but no NEW field can
  ever be disclosed. Treat witness loss as non-fatal (deal proceeds), unlike
  deal-record loss (REFUSAL).

### 4. Notarized attestation
- **category:** `airtight-att`
- **name:** `<deal_id>:<kind>` where kind ∈ `prompt | result | delivery`
- **body:** the object returned by `notarize()` —
  `{v, dealId, role, kind, termsHash, merkleRoot, payloadHash, issuedAt, chainId, signer, signature, digest}`
- Signed EIP-712 by the **same key that pays**, so an adjudicator can tie the
  attestation to the on-chain payer address without trusting either agent.
- **Domain is disjoint from USDC's EIP-3009 domain** (`AIRTIGHT Notary` / `1` /
  zero address vs `USD Coin` / `2` / token address). An attestation can never be
  replayed as a transfer authorization, or vice versa. This is what makes it
  safe to sign arbitrary agent output with the payment key.
- Safe to share: contains hashes and a signature, never key material and never
  the plaintext payload.

### 5. Seller mirror (same pair, opposite role)
- Same schema, `role:"seller"`; states used: `QUOTED → PAID → DELIVERED → CLOSED`.
- Seller verifies via facilitator `/verify` BEFORE marking `PAID`.

## State machine

```
INTENT → QUOTED → AUTHORIZED → IN_FLIGHT → PAID(tx_hash) → DELIVERED(payload_hash) → CLOSED
                                    ↘ (crash anywhere) ↖ resume-on-wake
PAID/DELIVERED/CLOSED --evidence--> DISPUTED (terminal)
```

`IN_FLIGHT` exists because it is the kill window: written AFTER signing, BEFORE
settlement confirm. Spike 002 proved SIGKILL here resumes with exactly ONE settlement.

## The five rules, mapped to schema

| Rule | Enforcement |
|---|---|
| Write-before-act | signer may only run if `state == AUTHORIZED` AND `terms_hash` present |
| Hash-verified | `tx_hash` checked on-chain at resume; payload sha256 vs `delivery.payload_sha256` |
| PAID-gates-transfer | send blocked unless `state ∈ {AUTHORIZED}` AND no `airtight-fp` entry |
| Resume-on-wake | cold start = `memory_recall(airtight-deal, deal_id)` → continue from `state` |
| Refuse-blind | missing/corrupt/mismatched record ⇒ print REFUSAL, act on nothing |

## DISPUTED vs REFUSAL

The single rule (`resume.mjs`): **you can only dispute what someone signed.**

| Situation | Verdict | Why |
|---|---|---|
| Valid counterparty signature, contradicted by reality | `DISPUTED` | Provable to a third party using their own signature |
| Record absent, incoherent, or hash won't recompute | `REFUSAL` | Could be our own memory corrupted — cannot attribute |
| Attestation signature fails to verify | `REFUSAL` | A forgery and a bit-flip in our store look identical |
| Bytes mismatch our record, no attestation exists | `REFUSAL` | Nobody to attribute the mismatch to |
| `tx_hash` recorded but not found on chain | `REFUSAL` | Unconfirmed ≠ fraudulent; never re-send on doubt |

This asymmetry is load-bearing in both directions. If unverifiable state escalated
to `DISPUTED`, anyone who could corrupt our memory could manufacture disputes
against honest sellers. If signed contradictions decayed to `REFUSAL`, we would
discard the only evidence an adjudicator can act on.

## Corruption policy

Any of these ⇒ treat record as absent ⇒ REFUSAL (never guess):
- required fields missing for current state (e.g. PAID without tx_hash)
- recomputed terms_hash mismatch
- fp entry exists but deal_id dangling

## Hard lines
- **Never store private keys or mnemonics in Sibyl Memory.** Keys stay in env.
  `notarize()` takes the key as an argument and returns no key material; the
  attestation record is what gets written, never the signer input.
- **Never sign agent output under the USDC EIP-712 domain.** Notarization uses
  the `AIRTIGHT Notary` domain exclusively. Reusing the payment domain to sign
  arbitrary content would let a counterparty harvest a transfer authorization.
- **Never put `airtight-witness` bodies in a disclosure blob.** Only
  `selectDisclosure()` output leaves the process; it carries the disclosed
  fields' nonces and nothing else. Withheld leaf hashes DO appear inside proof
  siblings — that is safe because leaves are blinded, and only because of that.
- `memory_forget` archives only — demo deletion beat must wipe the db path for real.


---

# Task Checkpointing — Schema v1

For work that is safe to repeat but expensive to repeat. Anything irreversible
belongs behind Payment Safety instead: a task with no record resumes from zero
by design, and that is the wrong answer for money.

### Task record
- **category:** `airtight-task`
- **name:** `<task_id>` — caller-chosen, or `tk-<unix_ts>-<4 hex>`
- **body** (dict):

```
{
  "v": 1,
  "task_id": "nightly-import",
  "state": "STARTED" | "STEP" | "DONE" | "FAILED",
  "step": 3,                      # highest step COMPLETED
  "total_steps": 8,               # optional, for progress display
  "label": "Nightly import",
  "meta": { ... },                # optional, caller's own
  "reason": "signal_SIGTERM",     # why the last write happened, if not routine
  "started_at": <iso>,
  "last_checkpoint_at": <iso>
}
```

Overwritten on every checkpoint, never appended: the record is the task's
current position, and a history would grow without bound on a long job.

### Rules

| Rule | Enforcement |
|---|---|
| Checkpoint before the risk | `checkpoint(id, n)` is called before step n+1 begins — the only thing that survives SIGKILL |
| No rewinding | a checkpoint behind the recorded step is refused; rewinding is how work runs twice |
| Idempotent start | `start()` returns the existing record untouched, so calling it every boot is correct |
| Resume, don't restart | `resume()` returns `resumeFrom`, the next step to run |
| Terminal DONE | checkpointing a DONE task is refused |

### `reason` values

`signal_SIGTERM` · `signal_SIGINT` · `exception: <message>` ·
`unhandled_rejection: <message>` · `memory_pressure:<fraction>` · `null` when
the checkpoint was routine.

### What crash hooks can and cannot do

`installCrashHooks()` annotates the failures a process can observe. It cannot
catch SIGKILL, an OOM kill, or power loss — those stop the process outright.
**On Windows there are no POSIX signals at all**: Node maps `kill('SIGTERM')`
onto `TerminateProcess`, so a SIGTERM there behaves exactly like a SIGKILL and
no handler runs. Exceptions and unhandled rejections are still captured.

This is why the checkpoint goes *before* the step and the hooks are only an
annotation. The hooks also re-raise what they caught — a handler that recorded
and swallowed would turn every crash into a clean exit 0.
