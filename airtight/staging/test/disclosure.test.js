import assert from 'node:assert';
import {
  buildCommitment, selectDisclosure, verifyDisclosure,
  verifyProof, leafHash, canonical
} from '../selective_disclosure/merkle.js';

const deal = {
  deal_id: 'dt-1693720000-ab12',
  resource_url: 'https://example.com/secret-resource/123',
  seller: '0xSellerAddressSensitive',
  price_usdc: 0.25,
  network: 'base-sepolia',
  created_at: '2026-09-03T08:00:00.000Z'
};

let passed = 0;
function t(name, fn){
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// --- proof correctness -----------------------------------------------------

t('every field proof verifies against the root', ()=>{
  const c = buildCommitment(deal);
  for(const f of c.fields){
    const leaf = leafHash(f.key, f.value, f.nonce);
    assert.ok(verifyProof(leaf, c.proofs[f.key], c.root), `proof for ${f.key}`);
  }
});

t('odd field counts verify (duplicated-node path)', ()=>{
  const c = buildCommitment({ a:1, b:2, c:3 });
  const blob = selectDisclosure(c, ['a','b','c']);
  assert.deepStrictEqual(verifyDisclosure(blob, c.root), { a:1, b:2, c:3 });
});

t('single-field commitment verifies', ()=>{
  const c = buildCommitment({ only:'one' });
  assert.deepStrictEqual(verifyDisclosure(selectDisclosure(c,['only']), c.root), { only:'one' });
});

// --- selective disclosure --------------------------------------------------

t('blob reveals only the selected fields', ()=>{
  const c = buildCommitment(deal);
  const blob = selectDisclosure(c, ['price_usdc','created_at']);
  const got = verifyDisclosure(blob, c.root);
  assert.deepStrictEqual(Object.keys(got).sort(), ['created_at','price_usdc']);

  // The serialized blob must not leak withheld values or their nonces.
  //
  // Withheld LEAF HASHES do appear — a Merkle proof is made of sibling hashes,
  // so any withheld field adjacent to a disclosed one is on the wire by
  // construction. That is safe only because leaves are blinded: a bare leaf
  // hash without its 128-bit nonce reveals nothing (see the brute-force test
  // below). This is the whole reason nonces exist here.
  const wire = JSON.stringify(blob);
  assert.ok(!wire.includes(deal.seller), 'withheld value leaked');
  assert.ok(!wire.includes(deal.resource_url), 'withheld value leaked');
  assert.ok(!wire.includes(deal.deal_id), 'withheld value leaked');
  for(const f of c.fields){
    if(['price_usdc','created_at'].includes(f.key)) continue;
    assert.ok(!wire.includes(f.nonce), `withheld nonce leaked: ${f.key}`);
    assert.ok(!wire.includes(f.key), `withheld field NAME leaked: ${f.key}`);
  }
});

// --- blinding --------------------------------------------------------------

t('same value under different nonces yields different leaves', ()=>{
  const a = buildCommitment({ price_usdc: 0.25 });
  const b = buildCommitment({ price_usdc: 0.25 });
  assert.notStrictEqual(a.root, b.root, 'roots must not be guessable from values alone');
});

t('a low-entropy field is not brute-forceable without its nonce', ()=>{
  const c = buildCommitment({ price_usdc: 0.25 });
  const target = c.fields[0].leaf;
  // Attacker knows the field name and the plausible value set; without the
  // 128-bit nonce no candidate reproduces the leaf.
  for(const guess of [0.01, 0.25, 1, 10, '0.25']){
    assert.notStrictEqual(leafHash('price_usdc', guess, '00'.repeat(16)).toString('hex'), target);
  }
});

// --- honesty checks (tamper detection) -------------------------------------

t('tampered value fails verification', ()=>{
  const c = buildCommitment(deal);
  const blob = selectDisclosure(c, ['price_usdc']);
  blob.disclosed[0].value = 0.01;
  assert.throws(()=>verifyDisclosure(blob, c.root), /proof failed for field: price_usdc/);
});

t('tampered nonce fails verification', ()=>{
  const c = buildCommitment(deal);
  const blob = selectDisclosure(c, ['seller']);
  blob.disclosed[0].nonce = 'ff'.repeat(16);
  assert.throws(()=>verifyDisclosure(blob, c.root), /proof failed/);
});

t('relabelled field fails verification', ()=>{
  const c = buildCommitment(deal);
  const blob = selectDisclosure(c, ['price_usdc']);
  blob.disclosed[0].key = 'max_amount_required';
  assert.throws(()=>verifyDisclosure(blob, c.root), /proof failed/);
});

t('blob from a different deal is rejected against the committed root', ()=>{
  const mine = buildCommitment(deal);
  const theirs = buildCommitment({ ...deal, price_usdc: 99 });
  const blob = selectDisclosure(theirs, ['price_usdc']);
  assert.throws(()=>verifyDisclosure(blob, mine.root), /does not match committed root/);
});

t('self-consistent forgery still fails against the committed root', ()=>{
  // Attacker rebuilds a whole commitment around the value they want. The blob
  // verifies internally, so the committed root is what actually binds them.
  const real = buildCommitment(deal);
  const forged = buildCommitment({ ...deal, price_usdc: 0.01 });
  const blob = selectDisclosure(forged, ['price_usdc']);
  assert.deepStrictEqual(verifyDisclosure(blob), { price_usdc: 0.01 }); // internally fine
  assert.throws(()=>verifyDisclosure(blob, real.root), /does not match committed root/);
});

t('swapped proof from another field fails', ()=>{
  const c = buildCommitment(deal);
  const blob = selectDisclosure(c, ['price_usdc','seller']);
  const [p, s] = blob.disclosed;
  [p.proof, s.proof] = [s.proof, p.proof];
  assert.throws(()=>verifyDisclosure(blob, c.root), /proof failed/);
});

t('unknown version is rejected', ()=>{
  const c = buildCommitment(deal);
  const blob = selectDisclosure(c, ['price_usdc']);
  blob.v = 2;
  assert.throws(()=>verifyDisclosure(blob, c.root), /unsupported disclosure version/);
});

// --- canonicalization ------------------------------------------------------

t('key order does not change the root', ()=>{
  const c1 = buildCommitment({ terms: { a:1, b:2 } });
  const leaf1 = c1.fields[0];
  const leaf2 = leafHash('terms', { b:2, a:1 }, leaf1.nonce);
  assert.strictEqual(leaf2.toString('hex'), leaf1.leaf);
});

t('canonical distinguishes string from number', ()=>{
  assert.notStrictEqual(canonical('1'), canonical(1));
});

t('selecting an absent field throws', ()=>{
  const c = buildCommitment(deal);
  assert.throws(()=>selectDisclosure(c, ['nope']), /no such field/);
});

console.log(`\nPASS disclosure.test — ${passed} assertions groups green`);
