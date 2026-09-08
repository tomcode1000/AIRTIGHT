/**
 * Conformance test: DealMemory over the real Sibyl Memory substrate.
 *
 * Runs the same operations the FileDriver suite covers, but against the actual
 * sibyl-memory-mcp server, so the two drivers are proven interchangeable rather
 * than assumed to be.
 *
 * Points SIBYL_MEMORY_DB at a throwaway file; it must never touch the user's
 * real store at ~/.sibyl-memory/memory.db. Skips cleanly when the server is not
 * installed, so this suite is safe to run on any machine.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SibylDriver } from '../memory/driver-sibyl.mjs';
import { DealMemory, paymentFingerprint } from '../memory/deals.mjs';
import { assessDeal, VERDICT } from '../staging/selective_disclosure/resume.mjs';

const BIN = process.env.SIBYL_MCP_BIN
  || ['../../.venv/Scripts/sibyl-memory-mcp.exe', '../../.venv/bin/sibyl-memory-mcp']
      .map(p => path.resolve(import.meta.dirname, p)).find(p => fs.existsSync(p));

if (!BIN) {
  console.log('SKIP sibyl.test: sibyl-memory-mcp not installed (set SIBYL_MCP_BIN to override)');
  process.exit(0);
}

const TERMS = {
  resource_url: 'https://seller.example/report/42',
  seller: '0x1111111111111111111111111111111111111111',
  pay_to: '0x1111111111111111111111111111111111111111',
  network: 'base-sepolia',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  price_cap_usdc: 0.25,
  max_amount_required: '250000',
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airtight-sibyl-'));
const DB = path.join(tmp, 'memory.db');
const HOME_DB = path.join(os.homedir(), '.sibyl-memory', 'memory.db');

let passed = 0;
const drivers = [];
function driver() { const d = new SibylDriver({ bin: BIN, db: DB }); drivers.push(d); return d; }
async function t(name, fn) { await fn(); passed++; console.log(`  ok  ${name}`); }

console.log(`sibyl conformance: db ${DB}\n`);

// Guard first: if this is wrong, every later test pollutes the real store.
await t('driver targets the throwaway db, not the user store', async () => {
  const d = driver();
  assert.strictEqual(d.dbPath, DB);
  assert.notStrictEqual(path.resolve(d.dbPath), path.resolve(HOME_DB));
});

await t('write and read round-trip a structured body', async () => {
  const d = driver();
  await d.write('airtight-test', 'r1', { v: 1, nested: { a: [1, 2, 3] }, s: 'x' });
  assert.deepStrictEqual(await d.read('airtight-test', 'r1'), { v: 1, nested: { a: [1, 2, 3] }, s: 'x' });
});

await t('a missing record reads as null, not an error', async () => {
  assert.strictEqual(await driver().read('airtight-test', 'nope'), null);
});

await t('records survive a completely new driver + server process', async () => {
  const a = driver();
  await a.write('airtight-test', 'persist', { marker: 'SURVIVED' });
  a.close();
  const b = driver();   // fresh process, nothing shared but the db file
  assert.deepStrictEqual(await b.read('airtight-test', 'persist'), { marker: 'SURVIVED' });
});

await t('list returns names in the category', async () => {
  const d = driver();
  await d.write('airtight-listtest', 'n1', { a: 1 });
  await d.write('airtight-listtest', 'n2', { a: 2 });
  const names = await d.list('airtight-listtest');
  assert.ok(names.includes('n1') && names.includes('n2'), JSON.stringify(names));
});

await t('names containing a colon round-trip (attestation keys)', async () => {
  const d = driver();
  await d.write('airtight-test', 'dt-1-ab:delivery', { kind: 'delivery' });
  assert.deepStrictEqual(await d.read('airtight-test', 'dt-1-ab:delivery'), { kind: 'delivery' });
});

// ── the same lifecycle the FileDriver suite proves ────────────────────────
await t('full deal lifecycle over Sibyl, INTENT to CLOSED', async () => {
  const mem = new DealMemory(driver());
  const { deal_id } = await mem.open({ role: 'buyer', terms: TERMS });
  await mem.transition(deal_id, 'QUOTED');
  await mem.transition(deal_id, 'AUTHORIZED', { authorization: { payer: '0xP' } });
  await mem.transition(deal_id, 'IN_FLIGHT', { payment: { fingerprint: 'a'.repeat(64) } });
  await mem.transition(deal_id, 'PAID', { payment: { fingerprint: 'a'.repeat(64), tx_hash: '0x' + 'b'.repeat(64) } });
  await mem.transition(deal_id, 'DELIVERED', { delivery: { payload_sha256: 'c'.repeat(64) } });
  const closed = await mem.transition(deal_id, 'CLOSED');
  assert.strictEqual(closed.state, 'CLOSED');
  assert.deepStrictEqual(closed.transitions.map(x => x.to),
    ['INTENT', 'QUOTED', 'AUTHORIZED', 'IN_FLIGHT', 'PAID', 'DELIVERED', 'CLOSED']);
});

await t('write-before-act is enforced over Sibyl too', async () => {
  const mem = new DealMemory(driver());
  const { deal_id } = await mem.open({ role: 'buyer', terms: TERMS });
  await mem.transition(deal_id, 'QUOTED');
  await assert.rejects(() => mem.transition(deal_id, 'AUTHORIZED'), /requires authorization\.payer/);
});

await t('a cold DealMemory resumes mid-deal from Sibyl alone', async () => {
  const first = new DealMemory(driver());
  const { deal_id } = await first.open({ role: 'buyer', terms: TERMS });
  await first.transition(deal_id, 'QUOTED');
  await first.transition(deal_id, 'AUTHORIZED', { authorization: { payer: '0xP' } });
  await first.transition(deal_id, 'IN_FLIGHT', { payment: { fingerprint: 'd'.repeat(64) } });
  first.driver.close();

  const cold = new DealMemory(driver());
  const a = assessDeal({ deal: await cold.get(deal_id), attestations: await cold.getAttestations(deal_id) });
  assert.strictEqual(a.verdict, VERDICT.RESUME, a.reason);
  assert.strictEqual(a.from, 'IN_FLIGHT');
  assert.strictEqual(a.action, 'reconcile-onchain');
});

await t('the replay guard persists across processes', async () => {
  const fp = paymentFingerprint({ resource: 'https://x/y', nonce: '0xabc', amount: '250000', payTo: '0xS' });
  const one = new DealMemory(driver());
  assert.strictEqual(await one.claimFingerprint(fp, 'deal-x'), true);
  one.driver.close();
  const two = new DealMemory(driver());
  assert.strictEqual(await two.isConsumed(fp), true);
  assert.strictEqual(await two.claimFingerprint(fp, 'deal-x'), false);
});

await t('the witness never reaches the shareable deal record', async () => {
  const mem = new DealMemory(driver());
  const deal = await mem.open({ role: 'buyer', terms: TERMS });
  const wire = JSON.stringify(deal);
  for (const f of (await mem.getWitness(deal.deal_id)).fields) {
    assert.ok(!wire.includes(f.nonce), `nonce for ${f.key} leaked`);
  }
});

for (const d of drivers) d.close();

// Windows keeps the sqlite file handle open briefly after the server process
// dies, so retry rather than failing a green run on a teardown race.
for (let i = 0; i < 10; i++) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); break; }
  catch { await new Promise(r => setTimeout(r, 200)); }
}
console.log(`\nPASS sibyl.test: ${passed} groups green`);
