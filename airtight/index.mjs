/**
 * AIRTIGHT — crash-proof deal memory for agents that pay.
 *
 * Drop this into an agent that spends money. The guarantee is that it cannot be
 * made to pay twice, cannot pay blind, and can always say afterwards what it
 * paid for — across crashes, against a counterparty you do not control.
 *
 * The ordering below is the entire product. Everything else is detail.
 *
 *   import { DealMemory, SibylDriver, signPayment, headerFromStored,
 *            assessDeal, mayTransfer } from 'airtight';
 *
 *   const mem = new DealMemory(new SibylDriver());
 *
 *   // 1. On wake, ask what you are allowed to do. Never assume.
 *   const deal = await mem.get(dealId);
 *   const verdict = assessDeal({ deal, attestations: await mem.getAttestations(dealId) });
 *   if (verdict.verdict !== 'RESUME') return;          // REFUSAL or DISPUTED
 *
 *   // 2. Commit to the terms BEFORE signing anything.
 *   const d = await mem.open({ role: 'buyer', terms });
 *
 *   // 3. Sign, then store, THEN pay. This order is the whole point: the
 *   //    EIP-3009 nonce is what makes the payment unrepeatable, so it must be
 *   //    durable before the money moves.
 *   const signed = signPayment({ privateKey, requirements });
 *   if (!await mem.claimFingerprint(signed.fingerprint, d.deal_id)) return;  // would double-pay
 *   await mem.transition(d.deal_id, 'IN_FLIGHT', {
 *     payment: { fingerprint: signed.fingerprint, x402: signed.stored },
 *   });
 *   await submitPayment(url, signed.header);
 *
 *   // 4. Killed anywhere above? On the next run step 1 returns
 *   //    RESUME/reconcile-onchain, and you re-submit the STORED authorisation:
 *   //       headerFromStored(deal.payment.x402)
 *   //    Same nonce, so the token contract settles it at most once. Signing a
 *   //    fresh one instead is the double-pay.
 *
 * Memory is load-bearing by construction: `transition()` refuses to record a
 * state whose evidence is absent, so the action it guards never happens.
 */

// ── memory ──────────────────────────────────────────────────────────────────
export { DealMemory, CAT, ORDER, newDealId, paymentFingerprint } from './memory/deals.mjs';
export { SibylDriver } from './memory/driver-sibyl.mjs';
export { FileDriver } from './memory/driver-file.mjs';   // test double, not for production

// ── what a woken agent may do ───────────────────────────────────────────────
export { assessDeal, mayTransfer, termsHash, VERDICT } from './staging/selective_disclosure/resume.mjs';

// ── x402 payment leg ────────────────────────────────────────────────────────
export {
  signPayment, headerFromStored, fingerprintFor, fingerprintOfStored,
  fetchChallenge, submitPayment, encodeHeader, CHAIN_IDS,
} from './x402/pay.mjs';

// ── proving a deal to someone else ──────────────────────────────────────────
export { notarize, verifyAttestation, verifyDelivery, payloadHash, KINDS } from './staging/selective_disclosure/notary.mjs';
export { buildCommitment, selectDisclosure, verifyDisclosure } from './staging/selective_disclosure/merkle.js';
