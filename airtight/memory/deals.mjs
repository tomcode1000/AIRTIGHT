/**
 * AIRTIGHT deal memory — the load-bearing layer.
 *
 * Every record in SCHEMA.md is written and read through here, and the state
 * machine's rules are enforced at the write, not by the caller remembering to
 * check. An agent cannot reach a state without having durably recorded the
 * evidence for it, because `transition()` refuses the write otherwise.
 *
 * Categories (SCHEMA.md): airtight-deal · airtight-fp · airtight-witness ·
 * airtight-att. The witness is stored apart from the deal record on purpose:
 * the deal record may be shown to a counterparty, the witness never may.
 */
import crypto from 'node:crypto';
import { canonical, buildCommitment } from '../staging/selective_disclosure/merkle.js';
import { termsHash } from '../staging/selective_disclosure/resume.mjs';

export const CAT = Object.freeze({
  DEAL: 'airtight-deal', FP: 'airtight-fp', WITNESS: 'airtight-witness', ATT: 'airtight-att',
});

export const ORDER = ['INTENT', 'QUOTED', 'AUTHORIZED', 'IN_FLIGHT', 'PAID', 'DELIVERED', 'CLOSED'];

// Legal transitions. Anything absent is refused — including same-state writes,
// which would let a caller quietly mutate terms after authorisation.
const LEGAL = {
  INTENT:     ['QUOTED', 'DISPUTED'],
  QUOTED:     ['AUTHORIZED', 'DISPUTED'],
  AUTHORIZED: ['IN_FLIGHT', 'DISPUTED'],
  IN_FLIGHT:  ['PAID', 'DISPUTED'],
  PAID:       ['DELIVERED', 'DISPUTED'],
  DELIVERED:  ['CLOSED', 'DISPUTED'],
  CLOSED:     [],
  DISPUTED:   [],
};

// Evidence each state requires before it may be entered. This is write-before-act
// expressed as data: no evidence, no write, no action.
const EVIDENCE = {
  QUOTED:     d => d.terms?.max_amount_required != null || 'QUOTED requires terms.max_amount_required from the 402 challenge',
  AUTHORIZED: d => !!d.authorization?.payer || 'AUTHORIZED requires authorization.payer',
  IN_FLIGHT:  d => !!d.payment?.fingerprint || 'IN_FLIGHT requires payment.fingerprint',
  PAID:       d => !!d.payment?.tx_hash || 'PAID requires payment.tx_hash',
  DELIVERED:  d => !!d.delivery?.payload_sha256 || 'DELIVERED requires delivery.payload_sha256',
  DISPUTED:   d => !!d.dispute?.evidence || 'DISPUTED requires dispute.evidence',
};

const iso = () => new Date().toISOString();
const sha256hex = buf => crypto.createHash('sha256').update(buf).digest('hex');

export function newDealId() {
  return `dt-${Math.floor(Date.now() / 1000)}-${crypto.randomBytes(2).toString('hex')}`;
}

/** sha256(resource|nonce|amount|payTo) — the replay guard from PORTING.md. */
export function paymentFingerprint({ resource, nonce, amount, payTo }) {
  return sha256hex(Buffer.from([resource, nonce, amount, payTo].map(String).join('|'), 'utf8'));
}

export class DealMemory {
  constructor(driver) {
    if (!driver?.write) throw new Error('DealMemory: a driver is required');
    this.driver = driver;
  }

  // ── deal records ────────────────────────────────────────────────────────
  async get(dealId) { return this.driver.read(CAT.DEAL, dealId); }
  async listDeals() { return this.driver.list(CAT.DEAL); }

  /**
   * Open a deal at INTENT and commit to its terms in one durable write.
   *
   * The disclosure commitment is built here rather than later so the root is
   * fixed before anything is negotiated — a root computed after the fact would
   * prove nothing about what the terms were at the start.
   */
  async open({ dealId = newDealId(), role, terms }) {
    if (role !== 'buyer' && role !== 'seller') throw new Error('open: role must be buyer|seller');
    if (!terms || typeof terms !== 'object') throw new Error('open: terms required');
    if (await this.get(dealId)) throw new Error(`open: deal ${dealId} already exists`);

    const commitment = buildCommitment(terms);
    // Witness first: if we die between these two writes, we have nonces for a
    // deal that does not exist (harmless) rather than a root we can never open
    // (permanently undisclosable).
    await this.driver.write(CAT.WITNESS, dealId, {
      v: 1, root: commitment.root,
      fields: commitment.fields.map(f => ({ key: f.key, value: f.value, nonce: f.nonce })),
    });

    const now = iso();
    const deal = {
      v: 1, deal_id: dealId, role, state: 'INTENT',
      terms, terms_hash: termsHash(terms),
      authorization: null, payment: null, delivery: null,
      disclosure: { merkle_root: commitment.root, fields: Object.keys(terms).sort() },
      transitions: [{ to: 'INTENT', at: now }],
      created_at: now, updated_at: now,
    };
    await this.driver.write(CAT.DEAL, dealId, deal);
    return deal;
  }

  /**
   * Advance a deal. Refuses illegal transitions and states whose evidence is
   * not present, and refuses any patch that would alter agreed terms.
   *
   * Returns the written record. Throws rather than returning a falsy value:
   * a caller that ignores a return value must not be able to proceed as if the
   * write had happened.
   */
  async transition(dealId, to, patch = {}) {
    const deal = await this.get(dealId);
    if (!deal) throw new Error(`transition: no deal record for ${dealId} — REFUSAL`);
    if (!LEGAL[deal.state]) throw new Error(`transition: unknown current state ${deal.state}`);
    if (!LEGAL[deal.state].includes(to)) {
      throw new Error(`transition: ${deal.state} -> ${to} is not a legal transition`);
    }
    if ('terms' in patch || 'terms_hash' in patch) {
      throw new Error('transition: terms are immutable once the deal is open');
    }

    const next = {
      ...deal, ...patch, state: to,
      transitions: [...deal.transitions, { to, at: iso() }],
      updated_at: iso(),
    };
    if (termsHash(next.terms) !== next.terms_hash) {
      throw new Error('transition: terms_hash no longer recomputes — refusing to write');
    }
    const check = EVIDENCE[to]?.(next);
    if (typeof check === 'string') throw new Error(`transition: ${check}`);

    await this.driver.write(CAT.DEAL, dealId, next);
    return next;
  }

  // ── replay guard ────────────────────────────────────────────────────────
  // Persisted, unlike acquisition-agent's in-memory Map ("restart clears it").
  // That admission in our own shipped code is the thesis this closes.

  async isConsumed(fingerprint) { return (await this.driver.read(CAT.FP, fingerprint)) !== null; }

  /**
   * Claim a fingerprint before signing. Returns false if already consumed.
   *
   * Called BEFORE the transfer, never after: a crash between claiming and
   * settling leaves a claimed fingerprint and an IN_FLIGHT deal, which resumes
   * by reconciling on chain. The reverse order would leave a settled payment
   * with no record, and the next wake would pay again.
   */
  async claimFingerprint(fingerprint, dealId) {
    if (!/^[0-9a-f]{64}$/.test(String(fingerprint))) throw new Error('claimFingerprint: fingerprint must be 32 bytes of hex');
    if (await this.isConsumed(fingerprint)) return false;
    await this.driver.write(CAT.FP, fingerprint, { deal_id: dealId, consumed_at: iso() });
    return true;
  }

  // ── attestations & witness ──────────────────────────────────────────────
  /**
   * Store an attestation under OUR local deal id.
   *
   * The key and the signed content are deliberately different things. The
   * signature binds the payment fingerprint, because that is the only id both
   * sides of a deal derive identically; the record is filed under the local
   * deal id, because that is how this agent looks it up. Filing it under the
   * fingerprint made every read miss.
   */
  async putAttestation(dealId, att) {
    if (!dealId) throw new Error('putAttestation: local dealId required');
    if (!att?.kind) throw new Error('putAttestation: attestation needs a kind');
    await this.driver.write(CAT.ATT, `${dealId}:${att.kind}`, att);
    return att;
  }
  async getAttestation(dealId, kind) { return this.driver.read(CAT.ATT, `${dealId}:${kind}`); }
  async getAttestations(dealId) {
    const out = {};
    for (const kind of ['prompt', 'result', 'delivery']) {
      const a = await this.getAttestation(dealId, kind);
      if (a) out[kind] = a;
    }
    return out;
  }

  /** Private — never include in anything sent to a counterparty. */
  async getWitness(dealId) { return this.driver.read(CAT.WITNESS, dealId); }
}

export default { DealMemory, CAT, ORDER, newDealId, paymentFingerprint };
