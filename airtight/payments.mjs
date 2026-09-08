/**
 * AIRTIGHT / Payment Safety: an agent that cannot be made to pay twice.
 *
 *   import { DealMemory, SibylDriver, signPayment, headerFromStored,
 *            assessDeal, mayTransfer, submitPayment } from 'airtight/payments';
 *
 * The ordering is the product:
 *
 *   1. On wake, ask what you may do, never assume.
 *        const v = assessDeal({ deal, attestations });
 *        if (v.verdict !== 'RESUME') return;      // REFUSAL, or DISPUTED
 *
 *   2. Commit to the terms before signing anything.
 *        const deal = await mem.open({ role: 'buyer', terms });
 *
 *   3. Sign, store, THEN pay. The EIP-3009 nonce is what makes the payment
 *      unrepeatable, so it must be durable before the money moves.
 *        const signed = signPayment({ privateKey, requirements });
 *        await mem.claimFingerprint(signed.fingerprint, deal.deal_id);
 *        await mem.transition(deal.deal_id, 'IN_FLIGHT', {
 *          payment: { fingerprint: signed.fingerprint, x402: signed.stored },
 *        });
 *        await submitPayment(url, signed.header);
 *
 *   4. Killed above? The next run re-submits headerFromStored(...): the same
 *      nonce, which the token contract honours exactly once.
 *
 * Records live in airtight-deal / -fp / -witness / -att. Independent of Task
 * Checkpointing; install either, or both.
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
