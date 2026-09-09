/**
 * The self-hosted facilitator, checked against a real chain.
 *
 * Everything here is free: signing costs nothing, and the nonce check is an
 * eth_call. Only the final broadcast needs gas, so that step asserts a clean
 * refusal rather than a crash when the settler is unfunded.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { signTransferWithAuthorization, deriveAddress } from '../staging/x402/signer.mjs';

const PORT = 4409;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const CHAIN = 84532;
let bad = 0;
const ok = (c, l, d = '') => { if (!c) bad++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  ' + d : ''}`); };

const settlerKey = '0x' + crypto.randomBytes(32).toString('hex');
const buyerKey = process.env.DEMO_BUYER_KEY;
if (!buyerKey) { console.log('DEMO_BUYER_KEY not set, load .env first'); process.exit(1); }

const child = spawn(process.execPath, ['facilitator/server.mjs'], {
  env: { ...process.env, FACILITATOR_KEY: settlerKey, FACILITATOR_PORT: String(PORT), X402_NETWORK: 'base-sepolia' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', () => {});
child.stderr.on('data', d => process.stderr.write(d));
await new Promise(r => setTimeout(r, 1200));

const post = async (p, b) => (await fetch(`http://localhost:${PORT}${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
})).json();

console.log('\nself-hosted facilitator\n');

const sup = await (await fetch(`http://localhost:${PORT}/supported`)).json();
ok(sup.kinds?.some(k => k.network === `eip155:${CHAIN}` && k.scheme === 'exact'),
   'advertises exact on eip155:' + CHAIN);

const payer = deriveAddress(buyerKey);
const signed = signTransferWithAuthorization({
  privateKey: buyerKey, from: payer, to: process.env.X402_PAY_TO, valueUsdc: 0.01,
  chainId: CHAIN, verifyingContract: USDC, tokenName: 'USDC', tokenVersion: '2',
});
const requirements = { payTo: process.env.X402_PAY_TO, maxAmountRequired: '10000', asset: USDC };
const payload = { network: 'base-sepolia', authorization: signed.authorization, signature: signed.signature };

const good = await post('/verify', { x402Version: 1, paymentPayload: payload, paymentRequirements: requirements });
ok(good.isValid === true, 'accepts a valid authorisation', good.invalidReason || '');
ok(String(good.payer).toLowerCase() === payer.toLowerCase(), 'recovers the right payer', good.payer);

// a signature from a different key must not pass as this payer
const other = '0x' + crypto.randomBytes(32).toString('hex');
const forged = signTransferWithAuthorization({
  privateKey: other, from: payer, to: process.env.X402_PAY_TO, valueUsdc: 0.01,
  chainId: CHAIN, verifyingContract: USDC, tokenName: 'USDC', tokenVersion: '2',
});
const f = await post('/verify', { x402Version: 1,
  paymentPayload: { ...payload, authorization: forged.authorization, signature: forged.signature },
  paymentRequirements: requirements });
ok(f.isValid === false, 'rejects a signature from the wrong key', f.invalidReason);

// paying someone else must not satisfy this resource
const wrongPayee = await post('/verify', { x402Version: 1, paymentPayload: payload,
  paymentRequirements: { ...requirements, payTo: '0x000000000000000000000000000000000000dEaD' } });
ok(wrongPayee.isValid === false, 'rejects payment to the wrong recipient', wrongPayee.invalidReason);

// paying less than asked must not satisfy it either
const tooLittle = await post('/verify', { x402Version: 1, paymentPayload: payload,
  paymentRequirements: { ...requirements, maxAmountRequired: '999999' } });
ok(tooLittle.isValid === false, 'rejects an underpayment', tooLittle.invalidReason);

// An expired authorisation must not settle. It has to be SIGNED expired, not
// edited afterwards: editing the window changes the digest, so the signature
// stops recovering and the test would pass for the wrong reason.
const old = signTransferWithAuthorization({
  privateKey: buyerKey, from: payer, to: process.env.X402_PAY_TO, valueUsdc: 0.01,
  chainId: CHAIN, verifyingContract: USDC, tokenName: 'USDC', tokenVersion: '2',
  ttlSeconds: -120,
});
const expired = await post('/verify', { x402Version: 1,
  paymentPayload: { ...payload, authorization: old.authorization, signature: old.signature },
  paymentRequirements: requirements });
ok(expired.isValid === false && /expired/.test(expired.invalidReason || ''),
   'rejects a validly signed but expired authorisation', expired.invalidReason);

// the settler holds no gas, so settle must refuse cleanly and say why
const s = await post('/settle', { x402Version: 1, paymentPayload: payload, paymentRequirements: requirements });
ok(s.success === false, 'unfunded settler fails rather than crashing');
ok(typeof s.errorReason === 'string' && s.errorReason.length > 0, 'and says why', s.errorReason?.slice(0, 90));

// A request with no stated requirements must not settle. There is nothing to
// check the recipient or amount against, so waving it through would spend our
// gas on any authorisation a stranger sent.
const bare = await post('/verify', { x402Version: 1, paymentPayload: payload });
ok(bare.isValid === false, 'refuses when no requirements are stated', bare.invalidReason);

child.kill();
console.log(bad ? `\n${bad} FAILED\n` : '\nall facilitator checks pass\n');
process.exit(bad ? 1 : 0);
