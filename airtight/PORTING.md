# AIRTIGHT — Port Inventory (pre-kickoff audit, Aug 24)

Source of truth: `/root/acquisition-agent` (live-verified x402 implementation).
Rule: product code written in-window Sep 1–10; this doc only maps WHAT ports WHERE.

## Reuse as-is (adapt imports)

| Source file | What it gives AIRTIGHT | Destination |
|---|---|---|
| `src/payment/x402.js` | 402 challenge builder (`buildPaymentRequirements`), header decode, facilitator `/verify` + `/settle` (handles BOTH CDP + open-facilitator dialects), USDC addresses + EIP-712 token meta (base mainnet name/version verified via eth_call Aug-23; sepolia verified live) | `airtight/x402/protocol.js` |
| `src/payment/signer.mjs` | Client-side `signTransferWithAuthorization` (EIP-3009) + `deriveAddress` — THE buyer signing leg | `airtight/x402/signer.mjs` |
| `src/payment/gate.js` | 402 gate middleware shape (seller side) | `airtight/seller/gate.js` |
| server.js L380–434 | `/sign` endpoint flow incl. **host-locking anti-oracle check** (never sign foreign resources) — keep this security pattern verbatim | `airtight/buyer/sign.js` |
| `test/x402.test.js`, `test/credits.test.js`, `server.integration.test.js` | Test scaffolding patterns | `airtight/test/` |

## The two admissions that ARE the pitch

From x402.js comments (our own shipped code):

1. **"Replay map is in-memory — restart clears it"** (L21–22, L43)
   → AIRTIGHT persists consumed-payment fingerprints in Sibyl Memory.
   Agent restart no longer loses payment state. This closes gap #452 client-side.

2. **Refund lane = service credits after terminal failure**
   → becomes the model for our DISPUTED branch: terminal failure auto-writes a
   dispute record (terms hash + tx hash + evidence) instead of silently eating loss.

## Config/env carried over (see .env.example at kickoff)

- `X402_NETWORK=base-sepolia` first (chain 84532, USDC `0x036C...CF7e`), flip mainnet later
- `PAYMENT_MODE=x402-mock` for demo rehearsal (auto-valid sig, fake settlement receipt) — rehearse kill -9 beats in mock, film final take on sepolia real settle
- CDP facilitator creds optional; open facilitator path already supported
- OPEN ITEM inherited: `X402_PAY_TO` must be set or challenge is unusable — seller wallet needed before D6 live run

## Memory hook points (where Sibyl writes happen)

1. INTENT/QUOTED/AUTHORIZED — buyer writes BEFORE calling signer (write-before-act)
2. PAID — write tx_hash from settlement receipt BEFORE consuming resource
3. DELIVERED — payload sha256 after receipt; mismatch → DISPUTED write
4. Consumed-payment fingerprints (replay guard, persisted — replaces in-memory Map)
5. Resume-on-wake: cold start reads last state; PAID present ⇒ never re-sign/re-send

## Not porting (scope guard)

- credits ledger admin views, job queue, scan lanes — acquisition-agent stays intact
- No negotiation/marketplace logic (roadmap scope guard)
