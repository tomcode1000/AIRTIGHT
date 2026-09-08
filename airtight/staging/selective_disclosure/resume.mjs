/**
 * AIRTIGHT: resume-on-wake assessment.
 *
 * A cold agent reads its own deal record and must answer one question before it
 * touches money: what, if anything, may I safely do next?
 *
 * ── The dispute/refusal line ────────────────────────────────────────────────
 * DISPUTED requires a VALID counterparty signature that contradicts reality.
 * That is evidence: they signed for payload X, they delivered Y, both facts are
 * provable to a third party.
 *
 * Everything else: a missing record, a hash that will not recompute, an
 * attestation whose signature does not verify: is indistinguishable from our
 * OWN memory having been corrupted or tampered with. We cannot tell a forgery
 * from a bit-flip in our store, so we fail closed: REFUSAL, act on nothing.
 *
 * Getting this backwards is dangerous in both directions. Treating unverifiable
 * state as DISPUTED lets an attacker who can corrupt our memory manufacture
 * disputes against honest sellers. Treating signed contradictions as REFUSAL
 * throws away the only provable evidence we will ever have.
 */
import crypto from 'node:crypto';
import { canonical } from './merkle.js';
import { verifyAttestation, payloadHash } from './notary.mjs';

export const VERDICT = Object.freeze({ RESUME: 'RESUME', REFUSAL: 'REFUSAL', DISPUTED: 'DISPUTED' });

const ORDER = ['INTENT', 'QUOTED', 'AUTHORIZED', 'IN_FLIGHT', 'PAID', 'DELIVERED', 'CLOSED'];

// What each state must carry to be internally coherent (SCHEMA.md corruption
// policy). A state claiming to be PAID with no tx_hash is not a deal record,
// it is damage.
const REQUIRED = {
  INTENT:    d => d.terms && d.terms_hash,
  QUOTED:    d => d.terms?.max_amount_required != null,
  AUTHORIZED:d => !!d.authorization?.payer,
  IN_FLIGHT: d => !!d.payment?.fingerprint,
  PAID:      d => !!d.payment?.tx_hash,
  DELIVERED: d => !!d.delivery?.payload_sha256,
  CLOSED:    d => !!d.delivery?.payload_sha256,
};

// The next action for a buyer waking at each state. IN_FLIGHT never re-signs,
// that is the double-pay window the whole project exists to close.
const NEXT_ACTION = {
  INTENT:    'request-quote',
  QUOTED:    'authorize',
  AUTHORIZED:'sign-and-send',
  IN_FLIGHT: 'reconcile-onchain',
  PAID:      'fetch-resource',
  DELIVERED: 'verify-and-close',
  CLOSED:    'none',
};

export function termsHash(terms) {
  return crypto.createHash('sha256').update(Buffer.from(canonical(terms), 'utf8')).digest('hex');
}

const refuse = reason => ({ verdict: VERDICT.REFUSAL, reason, action: 'none' });
const dispute = (reason, evidence) => ({ verdict: VERDICT.DISPUTED, reason, evidence, action: 'write-dispute' });

/**
 * Decide what a woken agent may do. Pure and synchronous: all external facts
 * (chain lookups, the bytes actually received) are passed in, so this is fully
 * testable and cannot itself perform an action.
 *
 * @param deal          the `airtight-deal` record, or null/undefined if absent
 * @param attestations  { [kind]: attestation } from `airtight-att`
 * @param delivered     Buffer|string actually received, if any
 * @param onChain       { txFound: bool|null }: null = not yet checked
 * @param counterparty  address we expect to have signed delivery attestations
 */
export function assessDeal({ deal, attestations = {}, delivered = null, onChain = {}, counterparty = null } = {}) {
  // ── 1. Do we have a record at all? ───────────────────────────────────────
  if (!deal || typeof deal !== 'object') return refuse('no deal record found');
  if (deal.v !== 1) return refuse(`unsupported record version: ${deal.v}`);
  if (deal.state === 'DISPUTED') {
    return { verdict: VERDICT.DISPUTED, reason: 'deal already disputed (terminal)', action: 'none' };
  }
  if (!ORDER.includes(deal.state)) return refuse(`unknown state: ${deal.state}`);

  // ── 2. Is the record internally coherent for the state it claims? ────────
  const idx = ORDER.indexOf(deal.state);
  for (const s of ORDER.slice(0, idx + 1)) {
    if (REQUIRED[s] && !REQUIRED[s](deal)) return refuse(`state ${deal.state} missing fields required by ${s}`);
  }
  if (termsHash(deal.terms) !== String(deal.terms_hash).toLowerCase()) {
    return refuse('terms_hash does not recompute: record altered');
  }
  if (deal.disclosure?.merkle_root != null && !/^[0-9a-f]{64}$/i.test(deal.disclosure.merkle_root)) {
    return refuse('disclosure.merkle_root malformed');
  }

  // ── 3. Payment-side consistency ──────────────────────────────────────────
  // A settled payment we cannot find on chain is not evidence of fraud; it is
  // us being unable to confirm our own state. Refuse rather than re-send.
  if (idx >= ORDER.indexOf('PAID') && onChain.txFound === false) {
    return refuse('recorded tx_hash not found on chain: refusing to act on unconfirmed payment');
  }

  // ── 4. Attestations ──────────────────────────────────────────────────────
  // Signature failure ⇒ corrupt or forged, indistinguishable ⇒ REFUSAL.
  for (const [kind, att] of Object.entries(attestations)) {
    if (!att) continue;

    // What may be asserted depends on WHO signed it.
    //
    // A counterparty's attestation is signed over THEIR record, so their
    // termsHash and merkleRoot are values we cannot reconstruct and must not
    // claim to know. The one identifier both sides derive identically is the
    // payment fingerprint; that is what a cross-party signature binds, and so
    // it is all we may check, alongside the address we expect to have signed.
    //
    // Our own attestations are over our own record, so the local deal id and
    // our disclosure root are both fair game.
    const ours = att.role === deal.role;
    const bindings = {};

    if (ours) {
      bindings.dealId = deal.deal_id;
      if (deal.disclosure?.merkle_root) bindings.merkleRoot = deal.disclosure.merkle_root;
    } else {
      if (deal.payment?.fingerprint) bindings.dealId = deal.payment.fingerprint;
      const expected = counterparty ?? deal.terms?.pay_to;
      if (expected && kind === 'delivery') bindings.signer = expected;
    }

    const res = verifyAttestation(att, bindings);
    if (!res.ok) return refuse(`attestation[${kind}] failed verification: ${res.reason}`);
  }

  // ── 5. Delivery: the one place DISPUTED is earned ────────────────────────
  const deliveryAtt = attestations.delivery;
  if (delivered != null) {
    const actual = payloadHash(delivered);

    // The counterparty SIGNED for a payload. What arrived is not it. Their own
    // signature is the evidence; this is the dispute case.
    if (deliveryAtt && deliveryAtt.payloadHash.toLowerCase() !== actual) {
      return dispute('delivered bytes do not match the signed attestation', {
        deal_id: deal.deal_id,
        signer: deliveryAtt.signer,
        signature: deliveryAtt.signature,
        attested_payload_hash: deliveryAtt.payloadHash,
        actual_payload_hash: actual,
        tx_hash: deal.payment?.tx_hash ?? null,
        terms_hash: deal.terms_hash,
      });
    }

    // No signature to hold them to. We only know our own record disagrees,
    // which our own memory could have caused. Fail closed.
    if (!deliveryAtt && deal.delivery?.payload_sha256 &&
        String(deal.delivery.payload_sha256).toLowerCase().replace(/^0x/, '') !== actual) {
      return refuse('delivered bytes do not match recorded hash, and no signed attestation to attribute it to');
    }
  }

  // Paid, and they signed for a delivery we never recorded receiving: still not
  // a dispute; we may simply have died before writing. Resume and re-fetch.
  return { verdict: VERDICT.RESUME, from: deal.state, action: NEXT_ACTION[deal.state] };
}

/**
 * Guard for the money-moving step. `assessDeal` says what we may do; this says
 * whether a transfer specifically is permitted. Both must agree before signing.
 */
export function mayTransfer({ deal, assessment, fingerprintConsumed = false }) {
  if (!assessment || assessment.verdict !== VERDICT.RESUME) return { ok: false, reason: 'assessment does not permit action' };
  if (deal.state !== 'AUTHORIZED') return { ok: false, reason: `transfer only from AUTHORIZED, not ${deal.state}` };
  if (fingerprintConsumed) return { ok: false, reason: 'payment fingerprint already consumed: would double-pay' };
  return { ok: true };
}

export default { assessDeal, mayTransfer, termsHash, VERDICT };
