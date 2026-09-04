# AIRTIGHT

**Crash-proof deal memory for agents that pay.**

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

## Where memory is load-bearing

Delete the memory and the product stops working — that is the design, not a
side effect. Three places to look, none more than a file away:

| What | Where |
|---|---|
| Every record written and read; state rules enforced at the write | [`airtight/memory/deals.mjs`](airtight/memory/deals.mjs) |
| What a woken agent is allowed to do, read from storage alone | [`airtight/staging/selective_disclosure/resume.mjs`](airtight/staging/selective_disclosure/resume.mjs) |
| Crash-safe durability (fsync → atomic rename → fsync dir) | [`airtight/memory/driver-file.mjs`](airtight/memory/driver-file.mjs) |

Five rules make it load-bearing:

1. **Write-before-act** — a state cannot be entered without its evidence
   durably recorded. `transition()` refuses the write, so the action never
   happens. This is data, not discipline: see `EVIDENCE` in `deals.mjs`.
2. **Hash-verified** — `terms_hash` must recompute on every wake; payload
   integrity is checked against a recorded sha256. Prose can be hallucinated,
   hashes cannot.
3. **PAID gates transfer** — payment fingerprints are claimed *before* signing
   and persist across restarts. The ported x402 code admits its replay map is
   "in-memory — restart clears it"; that admission is the gap this closes.
4. **Resume-on-wake** — a cold process reads the last verified state and
   continues exactly there. `IN_FLIGHT` resumes by reconciling, never by
   re-signing.
5. **Refuse-blind** — missing or corrupt memory produces a REFUSAL. The agent
   acts on nothing rather than guessing.

## Proof it works

```bash
cd airtight && npm test      # 86 groups across 5 suites
npm run chaos                # SIGKILL a real process at every boundary
```

The chaos suite spawns an actual buyer process, `SIGKILL`s it the moment it
reaches each boundary, then spawns a fresh one over the same store. The
settlement ledger is the assertion — **exactly one settlement, wherever the kill
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
reconciliation finds nothing and re-submits **the same** authorisation — the
EIP-3009 nonce is fixed, so the token contract honours it exactly once and the
retry is idempotent. Killed *after* settlement but before the `PAID` write,
reconciliation finds it and does not re-settle. Signing a *fresh* nonce in the
first case is the double-pay, and the difference between those two paths is
exactly what [x402 issue #452](https://github.com/coinbase/x402/issues/452)
leaves undefined.

## Proving a deal to someone else

Beyond surviving its own death, an agent can prove a *specific fact* about a
deal without revealing the rest of it.

- **Selective disclosure** ([`merkle.js`](airtight/staging/selective_disclosure/merkle.js))
  — commit a Merkle root over the terms at deal time, reveal chosen fields
  later with proofs. Leaves are blinded with 128-bit nonces: without them a
  low-entropy field like a price is brute-forceable straight out of its hash.
  Nonces live in a separate `airtight-witness` record, never in the shareable
  deal record.
- **Notarisation** ([`notary.mjs`](airtight/staging/selective_disclosure/notary.mjs))
  — sign a prompt, result or delivered payload with the *same key that pays*,
  so an adjudicator can tie it to the on-chain payer address. Signed under a
  domain deliberately disjoint from USDC's EIP-3009 domain, so an attestation
  can never be replayed as a transfer authorisation. Tested both directions.

Together these decide DISPUTED vs REFUSAL, under one rule: **you can only
dispute what someone signed.** A valid counterparty signature contradicted by
reality is evidence a third party can act on. Anything unverifiable is
indistinguishable from our own memory being corrupted, so it fails closed. If
unverifiable state escalated to DISPUTED, anyone who could corrupt our memory
could manufacture disputes against honest sellers.

## Status

Working and tested: deal memory, state machine, crash-safe driver, resume
assessment, selective disclosure, notarisation, SIGKILL chaos suite.

Not yet done: binding to the Sibyl Memory CLI (the driver seam exists,
`driver-file.mjs` is the local substrate), live x402 USDC settlement on Base
Sepolia, the seller agent, and the replay UI.

## Prior work

- **`acquisition-agent`** (author's own, pre-window) — the x402 client/server,
  EIP-3009 signer and 402 gate are ported from it, as inventoried in
  [PORTING.md](airtight/PORTING.md). `signer.mjs` gains two AIRTIGHT-authored
  exports (`recoverAddress`, `addressFromPubkey`); everything else in
  `airtight/staging/x402/` is prior work.
- **AUTOPSY** — sibling project by the same author.
- Inspiration and credit: **Internet Court** (third-party adjudication after a
  deal breaks) and **Fortytwo x402Escrow** (on-chain custody of funds
  mid-flight). AIRTIGHT is complementary and sits at a different layer — the
  agent's own deal state, client-side. Protocol gaps cited: x402 issues #452
  and #2887.

## Licence

MIT — see [LICENSE](LICENSE).
