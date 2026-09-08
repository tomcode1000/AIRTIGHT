# AIRTIGHT: Build Roadmap
**Crash-proof deal memory for agents that pay.**

Sibling brand to AUTOPSY: AUTOPSY holds dead deals accountable. AIRTIGHT makes deals survive death.

---

## Purpose

Autonomous agents transacting over x402 have no persistent, verifiable record of their own deals.
An agent that dies mid-purchase (OOM, deploy restart, network drop) wakes up blind:

- Did I already pay? → blind retry = **double-pay** (protocol issue #452: no idempotent retry semantics defined)
- Payment settled but payload never received → **paid, got nothing, no record**
- Dispute later → **no provable terms, authorization, or tx proof** (issue #2887: "the missing piece")

Existing players occupy other layers:
- Internet Court (★4.6k) = third-party adjudication AFTER a deal breaks
- Fortytwo x402Escrow (★11) = on-chain custody of FUNDS mid-flight
- Agent frameworks = chat-log "memory" (prose, hallucinable, not chain-verifiable)

**Unclaimed lane:** the agent's OWN deal state: persisted, resumable, verifiable.

## What it is

Every buyer/seller agent keeps its deal lifecycle in Sibyl Memory as a state machine:

```
INTENT → QUOTED → AUTHORIZED → PAID(tx_hash) → DELIVERED(payload_hash) → CLOSED
                                    ↘ DISPUTED(evidence)
```

Rules that make memory load-bearing:
1. **Write-before-act:** terms written BEFORE any money moves (seller id, price cap, authorization)
2. **Hash-verified records:** tx hash checked against chain; payload hash checks delivery integrity: prose can't be hallucinated, hashes verify
3. **PAID gates transfer:** no send unless memory confirms not-yet-paid → crash-safe by construction
4. **Resume-on-wake:** cold start reads last verified state and continues exactly there
5. **Refuse-blind:** memory missing/corrupt mid-deal → agent refuses to act (deletion test = gate)

## Aim (hackathon-calibrated)

- Pass the load-bearing gate cinematically: `kill -9` mid-deal on camera → respawn → resume correctly; delete memory mid-deal → deal safely aborts
- Top rubric band: coordination + dynamic-storage pattern (state machine in memory, not note-recall)
- Base ×1.15 multiplier: REAL x402 USDC settlement executed in the demo video (proven code from acquisition-agent)
- Score math: (rubric ~85+ est.) × 1.15 ≈ competitive for top-3 without PMF bonus (default 0 allowed)

## Tech stack (all proven on this box)

- Python, SQLite-based Sibyl Memory (`pip install 'sibyl-memory-cli[mcp]'`, venv: needs `apt install python3.13-venv` first)
- x402 client/server ported from `~/acquisition-agent` (live-verified USDC-on-Base)
- Replay UI: zero-build HTML/JS, slim instrument styling (web/index.html pattern from AUTOPSY)

---

## Timeline

### Pre-window (now → Aug 31)
- [x] **REGISTRATION: done Aug 24 (Toleexxzy self-filled form)**
- [ ] AUTOPSY submission Aug 31 (parallel, separate project: deprioritized by user)
- [x] Do NOT pre-build product code (commit history must be real & in-window): respected
- [x] STAGED Aug 25: `~/airtight/staging/` = protocol.js, signer.mjs, gate.js, /sign excerpt, tests (source 8/8 green): copies only, zero new logic
- [x] SCHEMA v1 locked: `~/airtight/SCHEMA.md` (adds IN_FLIGHT state per spike 002)
- [x] `sibyl init` ACTIVATED Aug 25 (stake tier): recovered post-crash via stateless /check claim; skill has the recipe
- [ ] OPEN: seller wallet for `X402_PAY_TO` needed before D6 live run

### D1-D2 (Sep 1-2): Foundation
- Public repo `airtight` (MIT), first commit day 1, conventional commits
- Install sibyl-memory-cli in venv; `sibyl init` (browser sign-in via phone) + `sibyl setup` auto-connect Hermes
- Port x402 pay client + 402-server from acquisition-agent into `airtight/x402/`
- Define deal-record schema (state, terms_hash, tx_hash, payload_hash, timestamps)

### D3-D4 (Sep 3-4): State machine core
- Transition engine with write-ahead rule; every transition = memory write first
- Resume logic: cold start → read state → continue
- Idempotency guard: PAID check gates any transfer
- Unit tests per transition incl. crash-between-every-pair

### D5 (Sep 5): Chaos suite + workshops
- SIGKILL harness: kill buyer process at each boundary → respawn → assert zero double-pay, correct resume
- Attend Sibyl workshops (remote); post build-log #1 tagging @sibylcap (public post #1)

### D6-D7 (Sep 6-7): Live E2E + UI
- Seller agent (scripted counterparty) + buyer agent, real x402 USDC settlement, small amounts, Base mainnet
- Full happy path + interrupted path recorded
- Replay UI: deal timeline viewer (slim/instrument styling)

### D8 (Sep 8): Gate proof + docs
- Deletion-test script (demo beat, reproducible)
- README: what/why, WHERE memory is load-bearing (paths < 2min findability rule), partner stacks + where, Prior Work declaration (AUTOPSY, acquisition-agent x402 code, inspiration credit Internet Court/Fortytwo issues #2887/#452/#2943)

### D9 (Sep 9): Demo video
- 2-5 min, ONE unedited fresh-session recall segment with on-screen timestamp + commit hash
- Beats: intro (15s) → live deal → kill -9 mid-deal (60s) → respawn resume (45s) → deletion break (45s) → close
- Post demo video publicly tagging @sibylcap + @basebuild (public post #2)

### D10 (Sep 10): Buffer + submit
- Fix anything, submit via emailed private build-page link
- Judging Sep 11-12 · winners Sep 13-15

---

## Risk register

| Risk | Mitigation |
|---|---|
| `sibyl init` browser sign-in friction | do it D1, phone available; email+code fallback |
| venv broken (python3.13-venv missing) | `apt install python3.13-venv` D1 |
| Real-money demo nerves | tiny fixed amounts, dry-run mode rehearsed first |
| Judge says "Temporal/saga rehash" | README leads with: runs on agent-native memory substrate, cross-runtime, chain-verifiable; cite protocol gaps #452 |
| Internet Court shadow | position as complementary client-side layer; credit them explicitly |
| Scope creep | NO marketplace, NO negotiation logic, NO multi-seller: one deal pair, perfect |

## Submission checklist (from rules)
- [ ] Public repo MIT/Apache-2.0, real commit history
- [ ] Demo video w/ fresh-session recall beat (timestamp/commit visible)
- [ ] README: load-bearing explanation + partner stacks + how memory made it possible + Prior Work
- [ ] Two public posts (@sibylcap tagged): build-log + demo video
- [ ] Submit link before Sep 10 23:59 UTC
