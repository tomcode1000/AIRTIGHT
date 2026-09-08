#!/usr/bin/env node
/**
 * AIRTIGHT buyer agent: the real x402 path, driven by durable memory.
 *
 * Walks one deal: 402 challenge → sign → store → settle → receive → close.
 * Safe to kill at any point and re-run; it continues from whatever reached
 * memory, and never pays twice.
 *
 * ── The ordering that makes it crash-safe ───────────────────────────────────
 *   1. fetch the 402 challenge, open the deal, commit to the terms
 *   2. sign the EIP-3009 authorisation
 *   3. STORE the signed authorisation + claim its fingerprint   ← before paying
 *   4. submit it
 *   5. record PAID with the settlement tx
 *
 * Step 3 before step 4 is the whole design. Killed between them, we wake with a
 * stored authorisation and re-submit THAT ONE: identical nonce, so the token
 * contract settles it at most once. Signing afresh on wake would mint a new
 * nonce and pay the seller twice.
 *
 * Usage: node buyer/agent.mjs <resource-url> [deal-id]
 * Env:   DEMO_BUYER_KEY (required), AIRTIGHT_STORE, AIRTIGHT_HOLD_AT,
 *        AIRTIGHT_MEMORY=sibyl|file
 */
import crypto from 'node:crypto';
import { FileDriver } from '../memory/driver-file.mjs';
import { SibylDriver } from '../memory/driver-sibyl.mjs';
import { DealMemory } from '../memory/deals.mjs';
import { assessDeal, mayTransfer, VERDICT } from '../staging/selective_disclosure/resume.mjs';
import { signPayment, headerFromStored, fetchChallenge, submitPayment } from '../x402/pay.mjs';
import { txFound, isTxHash } from '../x402/chain.mjs';
import { deriveAddress } from '../staging/x402/signer.mjs';
import { verifyAttestation, payloadHash } from '../staging/selective_disclosure/notary.mjs';

/**
 * Store the seller's signed statement of what it delivered, after checking it
 * actually covers the bytes we received. From here on the record is
 * self-incriminating for them: assessDeal re-verifies it on every wake, and a
 * valid signature over the wrong payload is what earns DISPUTED rather than a
 * REFUSAL. An unattested delivery is recorded as unattested, not rejected -
 * most sellers will never sign anything.
 */
async function recordAttestation(mem, dealId, deal, att, body) {
  if (!att) return { attested: false, reason: 'seller signed nothing' };
  // Bind only what BOTH sides can compute: the payment fingerprint as the
  // shared deal id, and the seller's address. Their termsHash and merkleRoot
  // are over their own record, which we cannot reconstruct and must not assert.
  const res = verifyAttestation(att, {
    dealId: deal.payment?.fingerprint, signer: deal.terms.pay_to,
  });
  if (!res.ok) return { attested: false, reason: `attestation rejected: ${res.reason}` };
  await mem.putAttestation(dealId, att);
  const matches = att.payloadHash.toLowerCase() === payloadHash(body);
  return { attested: true, matches, signer: res.signer };
}

const [resourceUrl, dealIdArg] = process.argv.slice(2);
if (!resourceUrl) { console.error('usage: node buyer/agent.mjs <resource-url> [deal-id]'); process.exit(2); }

const KEY = process.env.DEMO_BUYER_KEY;
if (!KEY || !/^0x[0-9a-fA-F]{64}$/.test(KEY)) {
  console.error('DEMO_BUYER_KEY must be set (0x + 64 hex). Run: node scripts/new-burner.mjs');
  process.exit(2);
}

const HOLD_AT = process.env.AIRTIGHT_HOLD_AT || null;
const say = s => {
  process.stdout.write(s + '\n');
  if (HOLD_AT && s.split(' ')[0] === HOLD_AT) {
    process.stdout.write(`\n  ── holding at ${HOLD_AT} ── kill -9 ${process.pid} ──\n\n`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
};

const driver = process.env.AIRTIGHT_MEMORY === 'file'
  ? new FileDriver(process.env.AIRTIGHT_STORE || '.airtight-memory')
  : new SibylDriver({
      bin: process.env.SIBYL_MCP_BIN || 'sibyl-memory-mcp',
      db: process.env.SIBYL_MEMORY_DB || null,
    });
const mem = new DealMemory(driver);
const dealId = dealIdArg || `dt-${Math.floor(Date.now() / 1000)}-${crypto.randomBytes(2).toString('hex')}`;

async function main() {
  let deal = await mem.get(dealId);

  // ── cold start ───────────────────────────────────────────────────────────
  if (!deal) {
    if (process.env.AIRTIGHT_RESUME_ONLY === '1') {
      say(`REFUSAL no verifiable deal state for ${dealId}: refusing to sign or pay`);
      process.exit(3);
    }
    const c = await fetchChallenge(resourceUrl);
    if (c.status !== 402) { say(`ABORT expected 402, got ${c.status}`); process.exit(4); }
    const a = c.challenge.accepts[0];

    // Terms are committed from the challenge itself, so what we later prove we
    // agreed to is exactly what the seller asked for.
    deal = await mem.open({
      dealId, role: 'buyer',
      terms: {
        resource_url: a.resource, seller: a.payTo, pay_to: a.payTo,
        network: a.network, asset: a.asset,
        price_cap_usdc: Number(a.maxAmountRequired) / 1e6,
        max_amount_required: a.maxAmountRequired,
      },
    });
    say(`AT:INTENT ${dealId}`);
    deal = await mem.transition(dealId, 'QUOTED');
    say(`AT:QUOTED ${a.maxAmountRequired} units to ${a.payTo}`);
  } else {
    // A recorded tx_hash came from a facilitator's word. Before acting on a deal
    // that claims to be paid, ask the chain. Unreachable RPC returns null and
    // changes nothing, only a definite "no such transaction" refuses.
    let onChain = {};
    if (isTxHash(deal.payment?.tx_hash)) {
      const found = await txFound(deal.payment.tx_hash, { network: deal.terms?.network });
      onChain = { txFound: found };
      if (found === true) say(`VERIFIED tx ${deal.payment.tx_hash.slice(0, 10)}… confirmed on ${deal.terms?.network}`);
      if (found === null) say('UNVERIFIED could not reach the chain: proceeding on the record');
    }

    const a = assessDeal({ deal, attestations: await mem.getAttestations(dealId), onChain });
    say(`RESUMED ${a.verdict} from ${a.from ?? '-'} → ${a.action}`);
    if (a.verdict !== VERDICT.RESUME) { say(`REFUSAL ${a.reason}`); process.exit(3); }
  }

  // Woken at INTENT: the deal is open but unquoted. Re-read the challenge.
  if (deal.state === 'INTENT') {
    const c = await fetchChallenge(deal.terms.resource_url);
    if (c.status !== 402) { say(`ABORT expected 402, got ${c.status}`); process.exit(4); }
    deal = await mem.transition(dealId, 'QUOTED');
    say(`AT:QUOTED ${deal.terms.max_amount_required} units to ${deal.terms.pay_to}`);
  }

  // ── authorise ────────────────────────────────────────────────────────────
  if (deal.state === 'QUOTED') {
    const price = deal.terms.price_cap_usdc;
    if (!(price > 0 && price <= Number(process.env.AIRTIGHT_MAX_USDC || 1))) {
      say(`REFUSAL price ${price} USDC exceeds cap: refusing to authorise`);
      process.exit(3);
    }
    // The payer is our own address, known before we sign anything: recording
    // it here is what makes AUTHORIZED mean something a later session can check.
    deal = await mem.transition(dealId, 'AUTHORIZED', {
      authorization: { payer: deriveAddress(KEY), authorized_at: new Date().toISOString() },
    });
    say('AT:AUTHORIZED');
  }

  // ── sign, store, then pay ────────────────────────────────────────────────
  if (deal.state === 'AUTHORIZED') {
    const guard = mayTransfer({ deal, assessment: assessDeal({ deal }) });
    if (!guard.ok) { say(`BLOCKED ${guard.reason}`); process.exit(4); }

    const challenge = await fetchChallenge(deal.terms.resource_url);
    if (challenge.status !== 402) { say(`ABORT expected 402, got ${challenge.status}`); process.exit(4); }

    const signed = signPayment({ privateKey: KEY, requirements: challenge.challenge });
    if (signed.stored.pay_to !== deal.terms.pay_to || signed.stored.amount !== deal.terms.max_amount_required) {
      // The seller changed the deal between quote and payment.
      say('REFUSAL challenge no longer matches the agreed terms');
      process.exit(3);
    }

    if (!await mem.claimFingerprint(signed.fingerprint, dealId)) {
      say('BLOCKED fingerprint already consumed: would double-pay');
      process.exit(4);
    }
    // Durable BEFORE the money moves. Everything needed to replay this exact
    // payment is now in memory.
    if (signed.payer !== deal.authorization.payer) {
      say('REFUSAL signed payer does not match the authorised payer');
      process.exit(3);
    }
    deal = await mem.transition(dealId, 'IN_FLIGHT', {
      payment: { fingerprint: signed.fingerprint, x402: signed.stored },
    });
    say(`AT:IN_FLIGHT nonce ${signed.stored.authorization.nonce.slice(0, 10)}…`);
  }

  // ── settle, or reconcile after a crash ───────────────────────────────────
  if (deal.state === 'IN_FLIGHT') {
    const stored = deal.payment?.x402;
    if (!stored) { say('REFUSAL IN_FLIGHT without a stored authorisation'); process.exit(3); }

    // Re-submitting the STORED authorisation, never a fresh signature. Same
    // nonce ⇒ the token contract can only honour it once.
    const header = headerFromStored(stored);
    const r = await submitPayment(deal.terms.resource_url, header);

    if (r.status === 409) {
      // The seller already consumed this payment, so we died after it settled.
      // Take the transaction hash from ITS receipt: deriving one from the nonce
      // would write a hash that does not exist, which is worse than none: the
      // record would look verified and fail every check made against it.
      const tx = r.receipt?.transaction || r.receipt?.txHash;
      if (!isTxHash(tx)) {
        say('REFUSAL payment consumed but the seller returned no verifiable tx');
        process.exit(3);
      }
      say('RECONCILE already-settled');
      deal = await mem.transition(dealId, 'PAID', {
        payment: { ...deal.payment, tx_hash: tx, settled_at: new Date().toISOString() },
      });
      say('AT:PAID (reconciled)');
    } else if (r.status === 200) {
      const tx = r.receipt?.transaction || r.receipt?.txHash || '0x_settled';
      say(`AT:SETTLED ${tx}`);
      deal = await mem.transition(dealId, 'PAID', {
        payment: { ...deal.payment, tx_hash: tx, settled_at: new Date().toISOString() },
      });
      say('AT:PAID');
      deal = await mem.transition(dealId, 'DELIVERED', {
        delivery: {
          payload_sha256: crypto.createHash('sha256').update(r.body).digest('hex'),
          received_at: new Date().toISOString(), bytes: Buffer.byteLength(r.body),
        },
      });
      const a = await recordAttestation(mem, dealId, deal, r.attestation, r.body);
      say(a.attested
        ? `AT:ATTESTED seller signed delivery · payload ${a.matches ? 'matches ✓' : 'MISMATCH ✗'}`
        : `AT:UNATTESTED ${a.reason}`);
      say('AT:DELIVERED');
    } else {
      say(`REFUSAL settlement not confirmable (HTTP ${r.status})`);
      process.exit(3);
    }
  }

  // Paid but nothing recorded as received: fetch again with the same payment.
  if (deal.state === 'PAID') {
    const r = await submitPayment(deal.terms.resource_url, headerFromStored(deal.payment.x402));
    if (r.status === 200) {
      deal = await mem.transition(dealId, 'DELIVERED', {
        delivery: {
          payload_sha256: crypto.createHash('sha256').update(r.body).digest('hex'),
          received_at: new Date().toISOString(), bytes: Buffer.byteLength(r.body),
        },
      });
      say('AT:DELIVERED');
    } else {
      say(`DISPUTE paid but undelivered (HTTP ${r.status})`);
      await mem.transition(dealId, 'DISPUTED', {
        dispute: { evidence: { tx_hash: deal.payment.tx_hash, terms_hash: deal.terms_hash, http_status: r.status } },
      });
      process.exit(5);
    }
  }

  if (deal.state === 'DELIVERED') { await mem.transition(dealId, 'CLOSED'); say('AT:CLOSED'); }
  say('DONE ' + dealId);
}

try { await main(); } finally { driver.close?.(); }
