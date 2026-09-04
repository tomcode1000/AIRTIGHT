import assert from 'node:assert';
import {
  notarize, verifyAttestation, verifyDelivery, payloadHash, KINDS
} from '../selective_disclosure/notary.mjs';
import { buildCommitment, selectDisclosure, verifyDisclosure } from '../selective_disclosure/merkle.js';
import { signTransferWithAuthorization, deriveAddress, recoverAddress } from '../x402/signer.mjs';

// Well-known test key. Not a real wallet; never used to hold funds.
const KEY = '0x1111111111111111111111111111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222222222222222222222222222';
const CHAIN = 84532; // base-sepolia
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const TERMS = 'a'.repeat(64);
const ROOT = 'b'.repeat(64);
const CONTENT = 'the delivered research report, verbatim';

let passed = 0;
function t(name, fn){ fn(); passed++; console.log(`  ok  ${name}`); }

const base = (over={}) => ({
  privateKey: KEY, dealId: 'dt-1693720000-ab12', role: 'buyer', kind: 'delivery',
  termsHash: TERMS, merkleRoot: ROOT, payloadHash: payloadHash(CONTENT),
  chainId: CHAIN, ...over
});

// --- round trip ------------------------------------------------------------

t('attestation round-trips and recovers the payer address', ()=>{
  const att = notarize(base());
  assert.strictEqual(att.signer, deriveAddress(KEY));
  const res = verifyAttestation(att);
  assert.ok(res.ok, res.reason);
  assert.strictEqual(res.signer, deriveAddress(KEY));
});

t('all three kinds notarize', ()=>{
  for(const kind of KINDS){
    assert.ok(verifyAttestation(notarize(base({ kind }))).ok, kind);
  }
});

t('attestation carries no key material', ()=>{
  const wire = JSON.stringify(notarize(base()));
  assert.ok(!wire.includes(KEY.slice(2)), 'private key leaked into attestation');
  assert.ok(!wire.includes(CONTENT), 'plaintext payload leaked into attestation');
});

// --- binding to the deal ---------------------------------------------------

t('verifyDelivery accepts the exact bytes and rejects altered bytes', ()=>{
  const att = notarize(base());
  assert.ok(verifyDelivery(att, CONTENT).ok);
  assert.strictEqual(verifyDelivery(att, CONTENT + ' ').ok, false);
});

t('caller-supplied bindings are enforced', ()=>{
  const att = notarize(base());
  assert.ok(verifyAttestation(att, { signer: deriveAddress(KEY), merkleRoot: ROOT, termsHash: TERMS }).ok);
  const bad = verifyAttestation(att, { merkleRoot: 'c'.repeat(64) });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.reason, /binding mismatch: merkleRoot/);
});

t('attestation binds a real disclosure commitment', ()=>{
  const c = buildCommitment({ price_usdc: 0.25, seller: '0xSeller', resource_url: 'https://x/y' });
  const att = notarize(base({ merkleRoot: c.root }));
  // Adjudicator: verify the signature, then verify a disclosed field under the
  // very root that signature commits to.
  assert.ok(verifyAttestation(att, { merkleRoot: c.root }).ok);
  const got = verifyDisclosure(selectDisclosure(c, ['price_usdc']), att.merkleRoot);
  assert.deepStrictEqual(got, { price_usdc: 0.25 });
});

// --- tampering -------------------------------------------------------------

t('tampered payloadHash fails', ()=>{
  const att = notarize(base());
  att.payloadHash = payloadHash('a different report');
  assert.strictEqual(verifyAttestation(att).ok, false);
});

t('tampered issuedAt fails', ()=>{
  const att = notarize(base());
  att.issuedAt = att.issuedAt - 3600;
  assert.strictEqual(verifyAttestation(att).ok, false);
});

t('re-labelling the signer fails', ()=>{
  const att = notarize(base());
  att.signer = deriveAddress(OTHER);
  const r = verifyAttestation(att);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /not made by the claimed signer/);
});

t('a stale digest field is caught', ()=>{
  const att = notarize(base());
  const other = notarize(base({ kind: 'prompt' }));
  att.digest = other.digest;
  assert.match(verifyAttestation(att).reason, /digest does not match/);
});

t('kind cannot be swapped after signing', ()=>{
  const att = notarize(base({ kind: 'prompt' }));
  att.kind = 'delivery';
  assert.strictEqual(verifyAttestation(att).ok, false);
});

t('role cannot be swapped after signing', ()=>{
  const att = notarize(base());
  att.role = 'seller';
  assert.strictEqual(verifyAttestation(att).ok, false);
});

t('chainId cannot be swapped after signing', ()=>{
  const att = notarize(base());
  att.chainId = 8453; // mainnet
  assert.strictEqual(verifyAttestation(att).ok, false);
});

// --- signature-level attacks ----------------------------------------------

t('malleated (high-s) signature is rejected', ()=>{
  const att = notarize(base());
  const r = att.signature.slice(2, 66);
  const s = BigInt('0x' + att.signature.slice(66, 130));
  const v = parseInt(att.signature.slice(130, 132), 16);
  // (r, N-s) is an equally valid ECDSA signature over the same digest.
  const flipped = (N - s).toString(16).padStart(64, '0');
  att.signature = '0x' + r + flipped + (v === 27 ? 28 : 27).toString(16).padStart(2, '0');
  const res = verifyAttestation(att);
  assert.strictEqual(res.ok, false, 'high-s variant must not verify');
  assert.match(res.reason, /does not recover/);
});

t('off-curve r does not recover', ()=>{
  const digest = Buffer.alloc(32, 7);
  // x=5 has no y on secp256k1 (5^3+7 is a non-residue mod p). recoverYfromX
  // returns a bogus root for such x, so recovery must reject it explicitly —
  // otherwise a forged r yields a real-looking address.
  const r = '0x' + '0'.repeat(63) + '5';
  assert.strictEqual(recoverAddress(digest, { r, s: '0x' + '1'.repeat(64), v: 27 }), null);
});

t('out-of-range v is rejected', ()=>{
  const digest = Buffer.alloc(32, 7);
  assert.strictEqual(recoverAddress(digest, { r: '0x' + '1'.repeat(64), s: '0x' + '1'.repeat(64), v: 99 }), null);
});

t('malformed signature string is rejected', ()=>{
  const att = notarize(base());
  att.signature = '0xdeadbeef';
  assert.match(verifyAttestation(att).reason, /malformed signature/);
});

// --- THE cross-protocol property ------------------------------------------

t('a USDC transfer authorization can never pose as an attestation', ()=>{
  const transfer = signTransferWithAuthorization({
    privateKey: KEY, from: deriveAddress(KEY), to: deriveAddress(OTHER),
    valueUsdc: 0.25, chainId: CHAIN,
    verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // sepolia USDC
  });
  const att = notarize(base());
  // Distinct domain separators ⇒ distinct digests for the same payer and chain.
  assert.notStrictEqual('0x' + transfer._digest, att.digest);
  // Splicing the payment signature into an attestation must not verify.
  att.signature = transfer.signature;
  assert.strictEqual(verifyAttestation(att).ok, false, 'payment signature verified as an attestation');
});

t('an attestation signature is not a valid transfer authorization', ()=>{
  const att = notarize(base());
  const transfer = signTransferWithAuthorization({
    privateKey: KEY, from: deriveAddress(KEY), to: deriveAddress(OTHER),
    valueUsdc: 0.25, chainId: CHAIN,
    verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  });
  // Recovering the attestation signature against the TRANSFER digest yields
  // some address, but never the payer's — so USDC would reject it.
  const m = /^0x([0-9a-f]{64})([0-9a-f]{64})([0-9a-f]{2})$/i.exec(att.signature);
  const rec = recoverAddress(Buffer.from(transfer._digest, 'hex'), {
    r: '0x' + m[1], s: '0x' + m[2], v: parseInt(m[3], 16),
  });
  assert.notStrictEqual(rec, deriveAddress(KEY));
});

// --- input guards ----------------------------------------------------------

t('bad inputs are refused, not silently signed', ()=>{
  assert.throws(()=>notarize(base({ privateKey: 'hunter2' })), /privateKey must be/);
  assert.throws(()=>notarize(base({ kind: 'invoice' })), /kind must be one of/);
  assert.throws(()=>notarize(base({ role: 'judge' })), /role must be buyer\|seller/);
  assert.throws(()=>notarize(base({ chainId: 0 })), /chainId required/);
  assert.throws(()=>notarize(base({ merkleRoot: 'tooshort' })), /merkleRoot must be 32 bytes/);
  assert.throws(()=>notarize(base({ termsHash: undefined })), /termsHash must be 32 bytes/);
});

console.log(`\nPASS notary.test — ${passed} groups green`);
