import assert from 'node:assert';
import { assessDeal, mayTransfer, termsHash, VERDICT } from '../selective_disclosure/resume.mjs';
import { notarize, payloadHash } from '../selective_disclosure/notary.mjs';
import { buildCommitment } from '../selective_disclosure/merkle.js';
import { deriveAddress } from '../x402/signer.mjs';

const SELLER_KEY = '0x2222222222222222222222222222222222222222222222222222222222222222';
const ATTACKER_KEY = '0x3333333333333333333333333333333333333333333333333333333333333333';
const SELLER = deriveAddress(SELLER_KEY);
const CHAIN = 84532;
const CONTENT = 'the delivered research report, verbatim';

const TERMS = {
  resource_url: 'https://seller.example/report/42',
  seller: SELLER,
  pay_to: SELLER,
  network: 'base-sepolia',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  price_cap_usdc: 0.25,
  max_amount_required: '250000',
};

const commitment = buildCommitment(TERMS);

function dealAt(state, over = {}) {
  const d = {
    v: 1, deal_id: 'dt-1693720000-ab12', role: 'buyer', state,
    terms: TERMS, terms_hash: termsHash(TERMS),
    authorization: { payer: deriveAddress('0x' + '11'.repeat(32)), authorized_at: '2026-09-04T10:00:00Z' },
    payment: { fingerprint: 'f'.repeat(64), tx_hash: '0x' + 'a'.repeat(64), settled_at: '2026-09-04T10:01:00Z' },
    delivery: { payload_sha256: payloadHash(CONTENT), received_at: '2026-09-04T10:02:00Z', bytes: 39 },
    disclosure: { merkle_root: commitment.root, fields: Object.keys(TERMS).sort() },
    transitions: [], created_at: '2026-09-04T10:00:00Z', updated_at: '2026-09-04T10:02:00Z',
  };
  return { ...d, ...over };
}

// The fingerprint is the shared identifier: a counterparty signs over that,
// never over our local record name, which it has no way to know.
const FP = 'f'.repeat(64);
const deliveryAtt = (over = {}) => notarize({
  privateKey: SELLER_KEY, dealId: FP, role: 'seller', kind: 'delivery',
  termsHash: termsHash(TERMS), merkleRoot: commitment.root,
  payloadHash: payloadHash(CONTENT), chainId: CHAIN, ...over,
});

let passed = 0;
function t(name, fn){ fn(); passed++; console.log(`  ok  ${name}`); }

// --- resume ----------------------------------------------------------------

t('resumes from each state with the right next action', ()=>{
  const expected = {
    INTENT: 'request-quote', QUOTED: 'authorize', AUTHORIZED: 'sign-and-send',
    IN_FLIGHT: 'reconcile-onchain', PAID: 'fetch-resource',
    DELIVERED: 'verify-and-close', CLOSED: 'none',
  };
  for(const [state, action] of Object.entries(expected)){
    const r = assessDeal({ deal: dealAt(state) });
    assert.strictEqual(r.verdict, VERDICT.RESUME, `${state}: ${r.reason}`);
    assert.strictEqual(r.action, action, state);
  }
});

t('IN_FLIGHT resumes by reconciling, never by re-signing', ()=>{
  const r = assessDeal({ deal: dealAt('IN_FLIGHT') });
  assert.strictEqual(r.action, 'reconcile-onchain');
  assert.notStrictEqual(r.action, 'sign-and-send');
});

t('valid delivery attestation over the real bytes resumes', ()=>{
  const r = assessDeal({
    deal: dealAt('DELIVERED'), attestations: { delivery: deliveryAtt() },
    delivered: CONTENT, counterparty: SELLER,
  });
  assert.strictEqual(r.verdict, VERDICT.RESUME, r.reason);
});

// --- refusal: unverifiable own state ---------------------------------------

t('absent record refuses', ()=>{
  assert.strictEqual(assessDeal({ deal: null }).verdict, VERDICT.REFUSAL);
  assert.strictEqual(assessDeal({}).verdict, VERDICT.REFUSAL);
});

t('PAID without tx_hash refuses', ()=>{
  const r = assessDeal({ deal: dealAt('PAID', { payment: { fingerprint: 'f'.repeat(64) } }) });
  assert.strictEqual(r.verdict, VERDICT.REFUSAL);
  assert.match(r.reason, /missing fields required by PAID/);
});

t('AUTHORIZED without authorization refuses', ()=>{
  const r = assessDeal({ deal: dealAt('AUTHORIZED', { authorization: null }) });
  assert.match(r.reason, /required by AUTHORIZED/);
});

t('altered terms refuse (terms_hash will not recompute)', ()=>{
  const d = dealAt('AUTHORIZED');
  d.terms = { ...d.terms, price_cap_usdc: 99 };
  const r = assessDeal({ deal: d });
  assert.strictEqual(r.verdict, VERDICT.REFUSAL);
  assert.match(r.reason, /terms_hash does not recompute/);
});

t('malformed disclosure root refuses', ()=>{
  const r = assessDeal({ deal: dealAt('PAID', { disclosure: { merkle_root: 'nope' } }) });
  assert.match(r.reason, /merkle_root malformed/);
});

t('unknown state and version refuse', ()=>{
  assert.match(assessDeal({ deal: dealAt('SETTLING') }).reason, /unknown state/);
  assert.match(assessDeal({ deal: dealAt('PAID', { v: 2 }) }).reason, /unsupported record version/);
});

t('tx_hash absent from chain refuses rather than re-paying', ()=>{
  const r = assessDeal({ deal: dealAt('PAID'), onChain: { txFound: false } });
  assert.strictEqual(r.verdict, VERDICT.REFUSAL);
  assert.match(r.reason, /not found on chain/);
});

// --- refusal: unverifiable attestations ------------------------------------

t('forged attestation signature refuses, does NOT dispute', ()=>{
  const att = deliveryAtt();
  att.payloadHash = payloadHash('something else entirely');
  const r = assessDeal({
    deal: dealAt('DELIVERED'), attestations: { delivery: att },
    delivered: CONTENT, counterparty: SELLER,
  });
  // An attacker who can corrupt our memory must not be able to manufacture a
  // dispute against an honest seller.
  assert.strictEqual(r.verdict, VERDICT.REFUSAL, 'must not escalate unverifiable data to DISPUTED');
  assert.match(r.reason, /failed verification/);
});

t('attestation signed by the wrong party refuses', ()=>{
  const att = deliveryAtt({ privateKey: ATTACKER_KEY });
  const r = assessDeal({
    deal: dealAt('DELIVERED'), attestations: { delivery: att },
    delivered: CONTENT, counterparty: SELLER,
  });
  assert.strictEqual(r.verdict, VERDICT.REFUSAL);
  assert.match(r.reason, /binding mismatch: signer/);
});

t('a seller attestation for a different payment refuses', ()=>{
  // Cross-party bindings are limited to what both sides derive identically.
  // The seller's own termsHash and merkleRoot are over THEIR record and cannot
  // be asserted from here; the payment fingerprint can.
  const att = deliveryAtt({ dealId: 'e'.repeat(64) });
  const r = assessDeal({
    deal: dealAt('DELIVERED'), attestations: { delivery: att },
    delivered: CONTENT, counterparty: SELLER,
  });
  assert.match(r.reason, /binding mismatch: dealId/);
});

t('a completed deal with a valid seller attestation resumes on wake', ()=>{
  // The regression that broke the live Deal Room: assessDeal bound the local
  // deal id, so every wake after a real delivery refused.
  const r = assessDeal({
    deal: dealAt('CLOSED'), attestations: { delivery: deliveryAtt() },
    counterparty: SELLER,
  });
  assert.strictEqual(r.verdict, VERDICT.RESUME, r.reason);
});

t('mismatched bytes with NO attestation refuses (nobody to attribute it to)', ()=>{
  const r = assessDeal({ deal: dealAt('DELIVERED'), delivered: 'wrong payload' });
  assert.strictEqual(r.verdict, VERDICT.REFUSAL);
  assert.match(r.reason, /no signed attestation to attribute it to/);
});

// --- dispute: earned by a valid signature contradicting reality ------------

t('valid signature + wrong bytes = DISPUTED with portable evidence', ()=>{
  const att = deliveryAtt();
  const r = assessDeal({
    deal: dealAt('DELIVERED'), attestations: { delivery: att },
    delivered: 'a truncated, useless report', counterparty: SELLER,
  });
  assert.strictEqual(r.verdict, VERDICT.DISPUTED, r.reason);
  assert.strictEqual(r.action, 'write-dispute');
  // Evidence must stand alone in front of an adjudicator.
  assert.strictEqual(r.evidence.signer, SELLER);
  assert.strictEqual(r.evidence.signature, att.signature);
  assert.strictEqual(r.evidence.attested_payload_hash, payloadHash(CONTENT));
  assert.strictEqual(r.evidence.actual_payload_hash, payloadHash('a truncated, useless report'));
  assert.ok(r.evidence.tx_hash && r.evidence.terms_hash);
});

t('DISPUTED is terminal — no action on wake', ()=>{
  const r = assessDeal({ deal: dealAt('DISPUTED') });
  assert.strictEqual(r.verdict, VERDICT.DISPUTED);
  assert.strictEqual(r.action, 'none');
});

t('paid but nothing received yet resumes to re-fetch, not dispute', ()=>{
  const d = dealAt('PAID', { delivery: null });
  const r = assessDeal({ deal: d, attestations: { delivery: deliveryAtt() }, counterparty: SELLER });
  assert.strictEqual(r.verdict, VERDICT.RESUME, r.reason);
  assert.strictEqual(r.action, 'fetch-resource');
});

// --- transfer guard --------------------------------------------------------

t('transfer allowed only from AUTHORIZED with an unconsumed fingerprint', ()=>{
  const deal = dealAt('AUTHORIZED');
  const a = assessDeal({ deal });
  assert.ok(mayTransfer({ deal, assessment: a }).ok);
  assert.strictEqual(mayTransfer({ deal, assessment: a, fingerprintConsumed: true }).ok, false);
});

t('transfer blocked from every non-AUTHORIZED state', ()=>{
  for(const s of ['INTENT','QUOTED','IN_FLIGHT','PAID','DELIVERED','CLOSED']){
    const deal = dealAt(s);
    const g = mayTransfer({ deal, assessment: assessDeal({ deal }) });
    assert.strictEqual(g.ok, false, `${s} must not permit transfer`);
  }
});

t('transfer blocked whenever the assessment is not RESUME', ()=>{
  const deal = dealAt('AUTHORIZED', { terms_hash: 'x'.repeat(64) });
  const g = mayTransfer({ deal, assessment: assessDeal({ deal }) });
  assert.strictEqual(g.ok, false);
});

console.log(`\nPASS resume.test — ${passed} groups green`);
