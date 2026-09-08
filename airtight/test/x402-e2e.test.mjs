/**
 * End-to-end x402: real 402 challenge, real EIP-3009 signing, real HTTP.
 *
 * Runs against a live seller process with PAYMENT_MODE=x402-mock, so the
 * protocol path is exercised for real while settlement is faked: no funds and
 * no network needed. The same code paths run against the facilitator when
 * PAYMENT_MODE is unset; only verify/settle change.
 *
 * The point of the last two tests: a stored authorisation replayed after a
 * crash is byte-identical, so the on-chain nonce makes it at-most-once. A
 * freshly signed one is a different nonce, and would pay twice.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  signPayment, headerFromStored, fingerprintOfStored,
  fetchChallenge, submitPayment, encodeHeader,
} from '../x402/pay.mjs';
import { deriveAddress } from '../staging/x402/signer.mjs';
import { decodePaymentHeader } from '../staging/x402/protocol.js';

const SERVER = fileURLToPath(new URL('../seller/server.mjs', import.meta.url));
const PORT = 4137;
const URL_ = `http://localhost:${PORT}/report/42`;

const BUYER_KEY = '0x' + '11'.repeat(32);
const PAY_TO = deriveAddress('0x' + '22'.repeat(32));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airtight-x402-'));

// This suite deliberately pays TWICE, to show what signing a fresh nonce costs.
// Harmless against a mock facilitator, real money against a live one, so it
// defaults to mock and refuses only when live was explicitly asked for. A
// silent skip during `npm test` would be worse than either.
if (process.env.PAYMENT_MODE === undefined) process.env.PAYMENT_MODE = 'x402-mock';
if (process.env.PAYMENT_MODE !== 'x402-mock') {
  console.log(`SKIP x402-e2e.test: PAYMENT_MODE=${process.env.PAYMENT_MODE} would spend real USDC (this suite double-pays on purpose)`);
  process.exit(0);
}

let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log(`  ok  ${name}`); }

const seller = spawn(process.execPath, [SERVER, String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PAYMENT_MODE: 'x402-mock',
    X402_NETWORK: 'base-sepolia',
    X402_PAY_TO: PAY_TO,
    X402_PRICE_USDC: '0.01',
    AIRTIGHT_SELLER_STORE: path.join(tmp, 'seller-store'),
  },
});
let sellerLog = '';
seller.stdout.on('data', d => sellerLog += d);
seller.stderr.on('data', d => sellerLog += d);

// Wait for the port rather than sleeping a guessed interval.
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`http://localhost:${PORT}/health`); if (r.ok) break; } catch {}
  await new Promise(r => setTimeout(r, 200));
}

try {
  let challenge, signed;

  await t('unpaid GET returns a 402 with usable requirements', async () => {
    const r = await fetchChallenge(URL_);
    assert.strictEqual(r.status, 402);
    challenge = r.challenge;
    const a = challenge.accepts[0];
    assert.strictEqual(a.scheme, 'exact');
    assert.strictEqual(a.network, 'base-sepolia');
    assert.strictEqual(a.payTo, PAY_TO);
    assert.strictEqual(a.asset, '0x036CbD53842c5426634e7929541eC2318f3dCF7e');
    assert.strictEqual(a.maxAmountRequired, '10000');           // 0.01 USDC, 6dp
    assert.deepStrictEqual(a.extra, { name: 'USDC', version: '2' });
  });

  await t('signing produces a decodable EIP-3009 authorisation', async () => {
    signed = signPayment({ privateKey: BUYER_KEY, requirements: challenge });
    assert.strictEqual(signed.payer, deriveAddress(BUYER_KEY));
    const d = decodePaymentHeader(signed.header);
    assert.ok(d, 'header must decode');
    assert.strictEqual(d.payload.authorization.from, signed.payer);
    assert.strictEqual(d.payload.authorization.to, PAY_TO);
    assert.strictEqual(d.payload.authorization.value, '10000');
    assert.match(d.payload.authorization.nonce, /^0x[0-9a-f]{64}$/);
    assert.match(d.payload.signature, /^0x[0-9a-f]{130}$/);
  });

  await t('an empty payTo is refused before anything is signed', async () => {
    const bad = { accepts: [{ ...challenge.accepts[0], payTo: '' }] };
    assert.throws(() => signPayment({ privateKey: BUYER_KEY, requirements: bad }), /empty payTo/);
  });

  await t('paying returns the payload and a settlement receipt', async () => {
    const r = await submitPayment(URL_, signed.header);
    assert.strictEqual(r.status, 200, r.body);
    assert.match(r.body, /research report/);
    assert.ok(r.receipt, 'X-PAYMENT-RESPONSE must carry a receipt');
    assert.strictEqual(r.receipt.success, true);
    assert.strictEqual(r.receipt.payer, signed.payer);
  });

  // ── the idempotency argument ─────────────────────────────────────────────

  await t('a stored authorisation rebuilds the IDENTICAL header', async () => {
    // This is the resume path: what memory recorded, replayed byte for byte.
    assert.strictEqual(headerFromStored(signed.stored), signed.header);
    assert.strictEqual(fingerprintOfStored(signed.stored), signed.fingerprint);
  });

  await t('re-submitting the stored payment re-delivers without re-settling', async () => {
    // A buyer that died before receiving its payload must be able to collect
    // it. Delivery is idempotent; settlement is not repeated.
    const before = (sellerLog.match(/settled /g) || []).length;
    const again = await submitPayment(URL_, headerFromStored(signed.stored));
    assert.strictEqual(again.status, 200, `expected re-delivery, got ${again.status}: ${again.body}`);
    assert.match(again.body, /research report/);
    assert.strictEqual(again.receipt?.replay, true, 'receipt must mark this a replay');
    const after = (sellerLog.match(/settled /g) || []).length;
    assert.strictEqual(after, before, 'a replay must not settle again');
  });

  await t('signing AGAIN yields a different nonce; this is the double-pay', async () => {
    const second = signPayment({ privateKey: BUYER_KEY, requirements: challenge });
    assert.notStrictEqual(second.stored.authorization.nonce, signed.stored.authorization.nonce);
    assert.notStrictEqual(second.fingerprint, signed.fingerprint);
    // A fresh nonce is a fresh payment: the seller accepts it and the buyer has
    // now paid twice for one deal. Only re-submitting the STORED authorisation
    // is safe, and only memory can hold it across a crash.
    const r = await submitPayment(URL_, second.header);
    assert.strictEqual(r.status, 200, 'a fresh nonce settles again: the failure memory prevents');
  });

  await t('an incomplete stored payment refuses to re-sign', async () => {
    assert.throws(() => headerFromStored({ authorization: signed.stored.authorization }), /refusing to re-sign/);
    assert.throws(() => headerFromStored(null), /refusing to re-sign/);
  });

  await t('a tampered amount is rejected by the seller', async () => {
    const tampered = encodeHeader({
      network: signed.stored.network,
      authorization: { ...signed.stored.authorization, value: '1' },
      signature: signed.stored.signature,
    });
    const r = await submitPayment(URL_, tampered);
    assert.notStrictEqual(r.status, 200, 'a rewritten amount must not be served');
  });
} finally {
  seller.kill();
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); break; }
    catch { await new Promise(r => setTimeout(r, 200)); }
  }
}

console.log(`\nPASS x402-e2e.test: ${passed} groups green`);
