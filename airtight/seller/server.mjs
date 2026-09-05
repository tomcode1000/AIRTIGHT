#!/usr/bin/env node
/**
 * AIRTIGHT seller — a real 402-gated resource.
 *
 * Unpaid GET returns a 402 carrying x402 payment requirements. A GET with a
 * valid X-PAYMENT header is verified through the facilitator, settled, and the
 * payload is returned with the settlement receipt in X-PAYMENT-RESPONSE.
 *
 * The seller keeps its own deal memory (role: "seller"), mirroring the buyer.
 * Its replay guard is PERSISTED, unlike the ported implementation's in-memory
 * Map whose own comment admits "restart clears it" — a seller that forgets
 * consumed payments across a restart will serve a replayed header for free.
 *
 * Usage: node seller/server.mjs [port]
 * Env:   X402_PAY_TO, X402_NETWORK, X402_PRICE_USDC, PAYMENT_MODE,
 *        X402_FACILITATOR_URL, AIRTIGHT_SELLER_STORE
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { buildPaymentRequirements, decodePaymentHeader, verifyPayment, settlePayment } from '../staging/x402/protocol.js';
import { FileDriver } from '../memory/driver-file.mjs';
import { DealMemory } from '../memory/deals.mjs';
import { fingerprintFor } from '../x402/pay.mjs';

const PORT = Number(process.argv[2] || process.env.PORT || 4021);
const STORE = process.env.AIRTIGHT_SELLER_STORE || '.airtight-seller';
const RESOURCE_PATH = '/report/42';

const PAYLOAD = JSON.stringify({
  report: 'the delivered research report, verbatim',
  generated_at: new Date().toISOString(),
}, null, 2);

const mem = new DealMemory(new FileDriver(STORE));
const log = (...a) => console.log(new Date().toISOString(), ...a);

function resourceUrl(req) {
  const host = req.headers.host || `localhost:${PORT}`;
  return `http://${host}${RESOURCE_PATH}`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, payTo: process.env.X402_PAY_TO || '', mode: process.env.PAYMENT_MODE || 'live' }));
  }
  if (url.pathname !== RESOURCE_PATH) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'not found' }));
  }

  const requirements = buildPaymentRequirements(resourceUrl(req), 'AIRTIGHT demo research report');
  const header = req.headers['x-payment'];

  // ── unpaid: issue the challenge ──────────────────────────────────────────
  if (!header) {
    log('402 challenge issued');
    res.writeHead(402, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(requirements));
  }

  const decoded = decodePaymentHeader(header);
  if (!decoded) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'malformed X-PAYMENT header' }));
  }

  const accept = requirements.accepts[0];

  // Check the authorisation against our OWN requirements before trusting the
  // facilitator. A buyer can sign a perfectly valid authorisation for the wrong
  // amount or the wrong recipient; that signature verifies, it just does not
  // pay us what was asked. Defence in depth matters here because mock mode
  // performs no signature check at all, so this is the only guard in dev.
  const auth = decoded.payload.authorization;
  if (auth.to?.toLowerCase() !== accept.payTo.toLowerCase()) {
    log('reject: authorisation pays', auth.to, 'not', accept.payTo);
    res.writeHead(402, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ...requirements, error: 'authorization pays the wrong recipient' }));
  }
  if (String(auth.value) !== String(accept.maxAmountRequired)) {
    log('reject: authorisation value', auth.value, 'expected', accept.maxAmountRequired);
    res.writeHead(402, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ...requirements, error: 'authorization amount does not match the price' }));
  }

  const fp = fingerprintFor({
    resource: accept.resource, nonce: decoded.payload.authorization.nonce,
    amount: accept.maxAmountRequired, payTo: accept.payTo,
  });

  try {
    // ── replay guard, read from durable memory ─────────────────────────────
    // A restart must not reopen this hole. The on-chain nonce stops a second
    // SETTLEMENT, but only this check stops us serving the payload twice for
    // one payment.
    if (await mem.isConsumed(fp)) {
      const prior = await mem.get(`seller-${fp.slice(0, 12)}`);
      if (prior?.state === 'DELIVERED' || prior?.state === 'CLOSED') {
        // Idempotent DELIVERY, not a refusal. This buyer already paid for this
        // payload; it may simply have died before receiving it. Serving the
        // same bytes again settles nothing and costs nothing, whereas refusing
        // would leave a paying customer with nothing — the exact failure this
        // project exists to prevent. Only a second SETTLEMENT would be wrong,
        // and that is barred by the fingerprint claim below and by the
        // on-chain nonce.
        log('replay: re-serving delivered payload for', fp.slice(0, 12));
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'X-AIRTIGHT-REPLAY': 'true',
          'X-PAYMENT-RESPONSE': Buffer.from(JSON.stringify({
            success: true, network: accept.network,
            transaction: prior.payment?.tx_hash ?? '0x_settled', payer: prior.authorization?.payer ?? '',
            replay: true,
          })).toString('base64'),
        });
        return res.end(PAYLOAD);
      }
    }

    const verified = await verifyPayment(header, requirements);
    if (!verified.isValid) {
      log('verify failed:', verified.invalidReason);
      res.writeHead(402, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ...requirements, error: verified.invalidReason || 'payment invalid' }));
    }

    // Write-before-act on the seller side too: record the deal and claim the
    // fingerprint BEFORE settling, so a crash mid-settle is recoverable rather
    // than an unrecorded transfer.
    const dealId = `seller-${fp.slice(0, 12)}`;
    if (!await mem.get(dealId)) {
      await mem.open({
        dealId, role: 'seller',
        terms: {
          resource_url: accept.resource, seller: accept.payTo, pay_to: accept.payTo,
          network: accept.network, asset: accept.asset,
          price_cap_usdc: Number(accept.maxAmountRequired) / 1e6,
          max_amount_required: accept.maxAmountRequired,
        },
      });
      await mem.transition(dealId, 'QUOTED');
      await mem.transition(dealId, 'AUTHORIZED', { authorization: { payer: verified.payer, authorized_at: new Date().toISOString() } });
      await mem.transition(dealId, 'IN_FLIGHT', { payment: { fingerprint: fp } });
    }
    await mem.claimFingerprint(fp, dealId);

    const { receipt, headerValue } = await settlePayment(header, requirements);
    if (receipt && receipt.success === false) {
      log('settle failed:', receipt.errorReason || JSON.stringify(receipt).slice(0, 120));
      res.writeHead(402, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'settlement failed', receipt }));
    }
    const tx = receipt?.transaction || receipt?.txHash || '0x_settled';
    log('settled', tx, 'payer', verified.payer);

    await mem.transition(dealId, 'PAID', {
      payment: { fingerprint: fp, tx_hash: tx, settled_at: new Date().toISOString() },
    });
    await mem.transition(dealId, 'DELIVERED', {
      delivery: {
        payload_sha256: crypto.createHash('sha256').update(PAYLOAD).digest('hex'),
        received_at: new Date().toISOString(), bytes: Buffer.byteLength(PAYLOAD),
      },
    });
    await mem.transition(dealId, 'CLOSED');

    res.writeHead(200, { 'Content-Type': 'application/json', 'X-PAYMENT-RESPONSE': headerValue });
    return res.end(PAYLOAD);
  } catch (e) {
    log('ERROR', e.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => {
  log(`AIRTIGHT seller on http://localhost:${PORT}${RESOURCE_PATH}`);
  log(`  network ${process.env.X402_NETWORK || 'base-sepolia'} · mode ${process.env.PAYMENT_MODE || 'live'} · payTo ${process.env.X402_PAY_TO || '(UNSET — challenge unusable)'}`);
});
