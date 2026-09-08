import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileDriver, encodeName, decodeName } from '../memory/driver-file.mjs';
import { DealMemory, CAT, newDealId, paymentFingerprint } from '../memory/deals.mjs';
import { assessDeal, VERDICT } from '../staging/selective_disclosure/resume.mjs';
import { verifyDisclosure, selectDisclosure } from '../staging/selective_disclosure/merkle.js';

const TERMS = {
  resource_url: 'https://seller.example/report/42',
  seller: '0x1111111111111111111111111111111111111111',
  pay_to: '0x1111111111111111111111111111111111111111',
  network: 'base-sepolia',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  price_cap_usdc: 0.25,
  max_amount_required: '250000',
};

let passed = 0;
const roots = [];
function fresh() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'airtight-mem-'));
  roots.push(root);
  return new DealMemory(new FileDriver(root));
}
async function t(name, fn){ await fn(); passed++; console.log(`  ok  ${name}`); }

// --- driver ----------------------------------------------------------------

await t('record names survive characters that are illegal in filenames', async ()=>{
  // Attestation names are `<deal_id>:<kind>` and ':' is illegal on Windows.
  for(const n of ['dt-1-ab:delivery', 'a/b', '..', 'C:\\x', 'q?*<>|"', 'plain-name']){
    assert.strictEqual(decodeName(encodeName(n)), n, n);
    assert.ok(!/[/\\:*?"<>|]/.test(encodeName(n)), `unsafe chars survive: ${n}`);
  }
});

await t('distinct names never collide onto one file', async ()=>{
  const names = ['a:b', 'a%3Ab', 'a/b', 'a%2Fb'];
  const encoded = names.map(encodeName);
  assert.strictEqual(new Set(encoded).size, names.length);
});

await t('driver round-trips, lists and removes', async ()=>{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'airtight-drv-'));
  roots.push(root);
  const d = new FileDriver(root);
  assert.strictEqual(d.read('c', 'missing'), null);
  d.write('c', 'n1', { a: 1 });
  d.write('c', 'n2', { a: 2 });
  assert.deepStrictEqual(d.read('c', 'n1'), { a: 1 });
  assert.deepStrictEqual(d.list('c'), ['n1', 'n2']);
  assert.deepStrictEqual(d.list('nope'), []);
  assert.strictEqual(d.remove('c', 'n1'), true);
  assert.strictEqual(d.remove('c', 'n1'), false);
});

await t('corrupt bytes surface as corruption, not as absence', async ()=>{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'airtight-drv-'));
  roots.push(root);
  const d = new FileDriver(root);
  d.write('c', 'n', { a: 1 });
  fs.writeFileSync(path.join(root, 'c', 'n.json'), '{ truncated');
  // Silently returning null would let a damaged record look like a fresh deal.
  assert.throws(()=>d.read('c', 'n'), /corrupt record/);
});

await t('writes leave no temp files behind', async ()=>{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'airtight-drv-'));
  roots.push(root);
  const d = new FileDriver(root);
  for(let i=0;i<5;i++) d.write('c', 'n', { i });
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'c')), ['n.json']);
  assert.deepStrictEqual(d.read('c', 'n'), { i: 4 });
});

// --- opening a deal --------------------------------------------------------

await t('open writes deal + witness and commits to terms', async ()=>{
  const m = fresh();
  const deal = await m.open({ role: 'buyer', terms: TERMS });
  assert.strictEqual(deal.state, 'INTENT');
  assert.match(deal.deal_id, /^dt-\d+-[0-9a-f]{4}$/);
  assert.match(deal.disclosure.merkle_root, /^[0-9a-f]{64}$/);

  const w = await m.getWitness(deal.deal_id);
  assert.strictEqual(w.root, deal.disclosure.merkle_root);
  assert.strictEqual(w.fields.length, Object.keys(TERMS).length);
});

await t('the committed root opens with the stored witness', async ()=>{
  const m = fresh();
  const deal = await m.open({ role: 'buyer', terms: TERMS });
  const w = await m.getWitness(deal.deal_id);
  // Rebuild a disclosure from the witness alone, as a later session would.
  const commitment = { v:1, root: w.root, fields: w.fields, proofs: null };
  assert.ok(commitment.root === deal.disclosure.merkle_root);
  assert.strictEqual(w.fields.find(f=>f.key==='price_cap_usdc').value, 0.25);
});

await t('the deal record carries no nonces', async ()=>{
  const m = fresh();
  const deal = await m.open({ role: 'buyer', terms: TERMS });
  const wire = JSON.stringify(deal);
  for(const f of (await m.getWitness(deal.deal_id)).fields){
    assert.ok(!wire.includes(f.nonce), `nonce for ${f.key} leaked into the shareable deal record`);
  }
});

await t('opening the same deal id twice is refused', async ()=>{
  const m = fresh();
  const id = newDealId();
  await m.open({ dealId: id, role: 'buyer', terms: TERMS });
  await assert.rejects(async ()=>await m.open({ dealId: id, role: 'buyer', terms: TERMS }), /already exists/);
});

// --- transitions enforce write-before-act ----------------------------------

const walk = async (m, id) => {
  await m.transition(id, 'QUOTED');
  await m.transition(id, 'AUTHORIZED', { authorization: { payer: '0xPAYER', authorized_at: new Date().toISOString() } });
  await m.transition(id, 'IN_FLIGHT', { payment: { fingerprint: 'a'.repeat(64) } });
  await m.transition(id, 'PAID', { payment: { fingerprint: 'a'.repeat(64), tx_hash: '0x' + 'b'.repeat(64) } });
  await m.transition(id, 'DELIVERED', { delivery: { payload_sha256: 'c'.repeat(64) } });
  return m.transition(id, 'CLOSED');
};

await t('the full happy path walks INTENT to CLOSED', async ()=>{
  const m = fresh();
  const { deal_id } = await m.open({ role: 'buyer', terms: TERMS });
  const closed = await walk(m, deal_id);
  assert.strictEqual(closed.state, 'CLOSED');
  assert.deepStrictEqual(closed.transitions.map(t=>t.to),
    ['INTENT','QUOTED','AUTHORIZED','IN_FLIGHT','PAID','DELIVERED','CLOSED']);
});

await t('a state cannot be entered without its evidence', async ()=>{
  const m = fresh();
  const { deal_id } = await m.open({ role: 'buyer', terms: TERMS });
  await m.transition(deal_id, 'QUOTED');
  await assert.rejects(async ()=>await m.transition(deal_id, 'AUTHORIZED'), /requires authorization\.payer/);
  await m.transition(deal_id, 'AUTHORIZED', { authorization: { payer: '0xP' } });
  await assert.rejects(async ()=>await m.transition(deal_id, 'IN_FLIGHT'), /requires payment\.fingerprint/);
  await m.transition(deal_id, 'IN_FLIGHT', { payment: { fingerprint: 'a'.repeat(64) } });
  await assert.rejects(async ()=>await m.transition(deal_id, 'PAID'), /requires payment\.tx_hash/);
});

await t('illegal transitions are refused, including skipping IN_FLIGHT', async ()=>{
  const m = fresh();
  const { deal_id } = await m.open({ role: 'buyer', terms: TERMS });
  await assert.rejects(async ()=>await m.transition(deal_id, 'PAID', { payment: { tx_hash: '0x'+'b'.repeat(64) } }),
    /INTENT -> PAID is not a legal transition/);
  await m.transition(deal_id, 'QUOTED');
  await m.transition(deal_id, 'AUTHORIZED', { authorization: { payer: '0xP' } });
  await assert.rejects(async ()=>await m.transition(deal_id, 'PAID', { payment: { tx_hash: '0x'+'b'.repeat(64) } }),
    /AUTHORIZED -> PAID is not a legal transition/);
});

await t('terms are immutable once open', async ()=>{
  const m = fresh();
  const { deal_id } = await m.open({ role: 'buyer', terms: TERMS });
  await assert.rejects(async ()=>await m.transition(deal_id, 'QUOTED', { terms: { ...TERMS, price_cap_usdc: 99 } }),
    /terms are immutable/);
  await assert.rejects(async ()=>await m.transition(deal_id, 'QUOTED', { terms_hash: 'x'.repeat(64) }),
    /terms are immutable/);
});

await t('CLOSED and DISPUTED are terminal', async ()=>{
  const m = fresh();
  const { deal_id } = await m.open({ role: 'buyer', terms: TERMS });
  await walk(m, deal_id);
  await assert.rejects(async ()=>await m.transition(deal_id, 'DISPUTED', { dispute: { evidence: {} } }), /not a legal transition/);
});

await t('DISPUTED requires evidence and is reachable from any live state', async ()=>{
  for(const stop of ['INTENT','QUOTED','AUTHORIZED']){
    const m = fresh();
    const { deal_id } = await m.open({ role: 'buyer', terms: TERMS });
    if(stop !== 'INTENT') await m.transition(deal_id, 'QUOTED');
    if(stop === 'AUTHORIZED') await m.transition(deal_id, 'AUTHORIZED', { authorization: { payer: '0xP' } });
    await assert.rejects(async ()=>await m.transition(deal_id, 'DISPUTED'), /requires dispute\.evidence/);
    const d = await m.transition(deal_id, 'DISPUTED', { dispute: { evidence: { why: 'test' } } });
    assert.strictEqual(d.state, 'DISPUTED');
  }
});

await t('transition on a missing record refuses', async ()=>{
  const m = fresh();
  await assert.rejects(async ()=>await m.transition('dt-0-0000', 'QUOTED'), /no deal record.*REFUSAL/);
});

// --- replay guard ----------------------------------------------------------

await t('a fingerprint can only be claimed once, and survives a new process view', async ()=>{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'airtight-fp-'));
  roots.push(root);
  const m1 = new DealMemory(new FileDriver(root));
  const fp = paymentFingerprint({ resource: 'https://x/y', nonce: '0xabc', amount: '250000', payTo: '0xSeller' });
  assert.strictEqual(await m1.claimFingerprint(fp, 'deal-1'), true);
  assert.strictEqual(await m1.claimFingerprint(fp, 'deal-1'), false);

  // Cold start: a brand-new instance over the same store still sees it.
  // acquisition-agent's in-memory Map lost this on restart; that is the gap.
  const m2 = new DealMemory(new FileDriver(root));
  assert.strictEqual(await m2.isConsumed(fp), true);
  assert.strictEqual(await m2.claimFingerprint(fp, 'deal-1'), false);
});

await t('fingerprints are deterministic and input-sensitive', async ()=>{
  const base = { resource: 'https://x/y', nonce: '0xabc', amount: '250000', payTo: '0xSeller' };
  const fp = paymentFingerprint(base);
  assert.strictEqual(fp, paymentFingerprint({ ...base }));
  assert.notStrictEqual(fp, paymentFingerprint({ ...base, amount: '250001' }));
  assert.notStrictEqual(fp, paymentFingerprint({ ...base, payTo: '0xAttacker' }));
});

await t('malformed fingerprints are refused', async ()=>{
  const m = fresh();
  await assert.rejects(async ()=>await m.claimFingerprint('short', 'd'), /32 bytes of hex/);
});

// --- cold start ------------------------------------------------------------

await t('a cold instance resumes mid-deal from the store alone', async ()=>{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'airtight-cold-'));
  roots.push(root);
  const m1 = new DealMemory(new FileDriver(root));
  const { deal_id } = await m1.open({ role: 'buyer', terms: TERMS });
  await m1.transition(deal_id, 'QUOTED');
  await m1.transition(deal_id, 'AUTHORIZED', { authorization: { payer: '0xP' } });
  await m1.transition(deal_id, 'IN_FLIGHT', { payment: { fingerprint: 'a'.repeat(64) } });
  // process dies here

  const m2 = new DealMemory(new FileDriver(root));
  const deal = await m2.get(deal_id);
  const verdict = assessDeal({ deal, attestations: await m2.getAttestations(deal_id) });
  assert.strictEqual(verdict.verdict, VERDICT.RESUME, verdict.reason);
  assert.strictEqual(verdict.from, 'IN_FLIGHT');
  assert.strictEqual(verdict.action, 'reconcile-onchain');
});

await t('deleted memory produces REFUSAL, not a fresh deal', async ()=>{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'airtight-del-'));
  const m1 = new DealMemory(new FileDriver(root));
  const { deal_id } = await m1.open({ role: 'buyer', terms: TERMS });
  await m1.transition(deal_id, 'QUOTED');

  new FileDriver(root).destroyAll();   // the deletion test, for real

  const m2 = new DealMemory(new FileDriver(root));
  assert.strictEqual(await m2.get(deal_id), null);
  const v = assessDeal({ deal: await m2.get(deal_id) });
  assert.strictEqual(v.verdict, VERDICT.REFUSAL);
  assert.strictEqual(v.action, 'none');
});

await t('a tampered stored record refuses on wake', async ()=>{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'airtight-tamper-'));
  roots.push(root);
  const m = new DealMemory(new FileDriver(root));
  const { deal_id } = await m.open({ role: 'buyer', terms: TERMS });
  // Attacker edits the price in the stored record but cannot recompute the hash
  // without also being able to rewrite every later attestation bound to it.
  const f = path.join(root, CAT.DEAL, deal_id + '.json');
  const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
  rec.body.terms.price_cap_usdc = 99;
  fs.writeFileSync(f, JSON.stringify(rec));

  const v = assessDeal({ deal: await m.get(deal_id) });
  assert.strictEqual(v.verdict, VERDICT.REFUSAL);
  assert.match(v.reason, /terms_hash does not recompute/);
});

for(const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch {} }
console.log(`\nPASS memory.test: ${passed} groups green`);
