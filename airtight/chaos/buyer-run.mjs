/**
 * A buyer run, designed to be killed.
 *
 * Walks one deal through the lifecycle against a real store, announcing each
 * boundary on stdout so the harness can SIGKILL it at a chosen point. Payment
 * is mocked (PAYMENT_MODE=x402-mock) and every settlement appends a line to a
 * ledger file — the ledger is how we prove, after a kill and a resume, that
 * exactly one payment happened.
 *
 * Usage: node buyer-run.mjs <store> <ledger> <dealId> [killAt]
 *   killAt: boundary name to stop announcing after; the harness does the killing.
 */
import fs from 'node:fs';
import { FileDriver } from '../memory/driver-file.mjs';
import { DealMemory, paymentFingerprint } from '../memory/deals.mjs';
import { assessDeal, mayTransfer, VERDICT } from '../staging/selective_disclosure/resume.mjs';

const [store, ledger, dealId] = process.argv.slice(2);

const TERMS = {
  resource_url: 'https://seller.example/report/42',
  seller: '0x1111111111111111111111111111111111111111',
  pay_to: '0x1111111111111111111111111111111111111111',
  network: 'base-sepolia',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  price_cap_usdc: 0.25,
  max_amount_required: '250000',
};
const PAYLOAD = 'the delivered research report, verbatim';

const say = s => { process.stdout.write(s + '\n'); };

// The mocked settlement. Appending here is the irreversible act that a real
// USDC transfer would be — if this file ever gets two lines for one deal, we
// double-paid.
function settle(fingerprint) {
  fs.appendFileSync(ledger, JSON.stringify({ deal: dealId, fingerprint, at: Date.now() }) + '\n');
  return '0x' + fingerprint.slice(0, 64);
}

const mem = new DealMemory(new FileDriver(store));

// ── cold start ─────────────────────────────────────────────────────────────
let deal = mem.get(dealId);
if (!deal) {
  deal = mem.open({ dealId, role: 'buyer', terms: TERMS });
  say('AT:INTENT');
} else {
  const a = assessDeal({ deal, attestations: mem.getAttestations(dealId) });
  say(`RESUMED:${a.verdict}:${a.from ?? '-'}:${a.action}`);
  if (a.verdict !== VERDICT.RESUME) { say(`REFUSAL:${a.reason}`); process.exit(3); }
}

const fp = paymentFingerprint({
  resource: TERMS.resource_url, nonce: '0x' + 'de'.repeat(16),
  amount: TERMS.max_amount_required, payTo: TERMS.pay_to,
});

// ── drive forward from wherever we actually are ────────────────────────────
if (deal.state === 'INTENT') { deal = mem.transition(dealId, 'QUOTED'); say('AT:QUOTED'); }

if (deal.state === 'QUOTED') {
  deal = mem.transition(dealId, 'AUTHORIZED', {
    authorization: { payer: '0x2222222222222222222222222222222222222222', authorized_at: new Date().toISOString() },
  });
  say('AT:AUTHORIZED');
}

if (deal.state === 'AUTHORIZED') {
  const guard = mayTransfer({ deal, assessment: assessDeal({ deal }), fingerprintConsumed: mem.isConsumed(fp) });
  if (!guard.ok) { say(`BLOCKED:${guard.reason}`); process.exit(4); }

  // Claim, then record IN_FLIGHT, then settle. This ordering is the whole
  // point: the kill window sits between the durable claim and the settlement.
  if (!mem.claimFingerprint(fp, dealId)) { say('BLOCKED:fingerprint already consumed'); process.exit(4); }
  deal = mem.transition(dealId, 'IN_FLIGHT', { payment: { fingerprint: fp } });
  say('AT:IN_FLIGHT');

  const tx = settle(fp);
  say('AT:SETTLED');
  deal = mem.transition(dealId, 'PAID', { payment: { fingerprint: fp, tx_hash: tx, settled_at: new Date().toISOString() } });
  say('AT:PAID');
}

if (deal.state === 'IN_FLIGHT') {
  // Woken mid-flight. We must NOT re-settle; reconcile instead. In production
  // this is an eth_getTransactionReceipt against the recorded fingerprint's tx.
  const settled = fs.existsSync(ledger)
    ? fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map(JSON.parse).find(r => r.fingerprint === fp)
    : null;
  say(`RECONCILE:${settled ? 'found' : 'not-found'}`);

  let tx;
  if (settled) {
    tx = '0x' + fp.slice(0, 64);
  } else {
    // Not on chain: the settlement never landed, so the deal is unfinished
    // rather than unsafe. Re-submit the SAME authorisation — the EIP-3009
    // nonce is fixed and the token contract will only honour it once, which
    // makes this retry idempotent. Signing a FRESH nonce here is the
    // double-pay, and is what protocol issue #452 leaves undefined.
    const claim = mem.driver.read('airtight-fp', fp);
    if (claim?.deal_id !== dealId) { say('REFUSAL:fingerprint belongs to another deal'); process.exit(3); }
    tx = settle(fp);
    say('AT:RESETTLED');
  }
  deal = mem.transition(dealId, 'PAID', {
    payment: { fingerprint: fp, tx_hash: tx, settled_at: new Date().toISOString() },
  });
  say('AT:PAID');
}

if (deal.state === 'PAID') {
  const { createHash } = await import('node:crypto');
  deal = mem.transition(dealId, 'DELIVERED', {
    delivery: {
      payload_sha256: createHash('sha256').update(PAYLOAD).digest('hex'),
      received_at: new Date().toISOString(), bytes: Buffer.byteLength(PAYLOAD),
    },
  });
  say('AT:DELIVERED');
}

if (deal.state === 'DELIVERED') { mem.transition(dealId, 'CLOSED'); say('AT:CLOSED'); }

say('DONE');
