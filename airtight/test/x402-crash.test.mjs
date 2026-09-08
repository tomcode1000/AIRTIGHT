/**
 * The claim, end to end: kill the buyer at every boundary of a REAL x402 deal
 * and prove the seller settles exactly once.
 *
 * Unlike the mock chaos suite, this drives the full protocol: 402 challenge,
 * EIP-3009 signature, HTTP payment, settlement receipt: against a live seller
 * process. Settlement is mocked at the facilitator only, so no funds are moved;
 * every other byte is the real path.
 *
 * The seller counts settlements. One deal must produce exactly one, wherever
 * the kill landed. Two would mean the buyer signed a fresh nonce on wake, which
 * is precisely the failure durable memory exists to prevent.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FileDriver } from '../memory/driver-file.mjs';
import { DealMemory } from '../memory/deals.mjs';
import { deriveAddress } from '../staging/x402/signer.mjs';

const SELLER = fileURLToPath(new URL('../seller/server.mjs', import.meta.url));
const BUYER = fileURLToPath(new URL('../buyer/agent.mjs', import.meta.url));
const PORT = 4141;
const RESOURCE = `http://localhost:${PORT}/report/42`;

const BUYER_KEY = '0x' + '11'.repeat(32);
const PAY_TO = deriveAddress('0x' + '22'.repeat(32));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airtight-x402crash-'));
const SELLER_STORE = path.join(tmp, 'seller');

const BOUNDARIES = ['AT:INTENT', 'AT:QUOTED', 'AT:AUTHORIZED', 'AT:IN_FLIGHT', 'AT:SETTLED', 'AT:PAID', 'AT:DELIVERED'];

const seller = spawn(process.execPath, [SELLER, String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PAYMENT_MODE: 'x402-mock', X402_NETWORK: 'base-sepolia',
         X402_PAY_TO: PAY_TO, X402_PRICE_USDC: '0.01', AIRTIGHT_SELLER_STORE: SELLER_STORE },
});
let sellerLog = '';
seller.stdout.on('data', d => sellerLog += d);
seller.stderr.on('data', d => sellerLog += d);

for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`http://localhost:${PORT}/health`); if (r.ok) break; } catch {}
  await new Promise(r => setTimeout(r, 200));
}

function runBuyer(store, dealId, killAt = null) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [BUYER, RESOURCE, dealId], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DEMO_BUYER_KEY: BUYER_KEY, AIRTIGHT_MEMORY: 'file',
             AIRTIGHT_STORE: store, AIRTIGHT_MAX_USDC: '1' },
    });
    let out = '', killed = false;
    child.stdout.on('data', d => {
      out += d.toString();
      if (killAt && !killed && out.split('\n').some(l => l.split(' ')[0] === killAt)) {
        killed = true; child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', d => out += d.toString());
    child.on('close', (code, signal) => resolve({ out, code, signal, killed }));
  });
}

/** How many times the seller actually settled for this deal. */
const settlementsFor = payer => (sellerLog.match(/settled /g) || []).length;

let passed = 0, failed = 0;
console.log('x402 crash suite: real protocol, killed at every boundary\n');

for (const boundary of BOUNDARIES) {
  const store = path.join(tmp, 'buyer-' + boundary.replace(/\W/g, '_'));
  const dealId = 'dt-x402-' + boundary.replace(/\W/g, '').toLowerCase();
  const before = settlementsFor();

  const first = await runBuyer(store, dealId, boundary);
  const second = await runBuyer(store, dealId);          // cold respawn
  const settled = settlementsFor() - before;
  const deal = await new DealMemory(new FileDriver(store)).get(dealId);

  const problems = [];
  if (!first.killed) problems.push(`never reached ${boundary}`);
  if (settled !== 1) problems.push(`seller settled ${settled}x, expected exactly 1`);
  if (deal?.state !== 'CLOSED') problems.push(`final state ${deal?.state}, expected CLOSED`);
  if (!second.out.includes('DONE')) problems.push('resume did not complete');

  if (problems.length) {
    failed++;
    console.log(`  FAIL  kill at ${boundary.padEnd(14)} → ${problems.join('; ')}`);
    console.log(`        first:  ${JSON.stringify(first.out).slice(0, 300)}`);
    console.log(`        second: ${JSON.stringify(second.out).slice(0, 300)}`);
  } else {
    passed++;
    const from = /RESUMED \w+ from (\w+|-)/.exec(second.out)?.[1] ?? '(fresh)';
    console.log(`  ok    kill at ${boundary.padEnd(14)} → resumed ${from.padEnd(11)} · 1 settlement · CLOSED`);
  }
}

seller.kill();
for (let i = 0; i < 10; i++) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); break; }
  catch { await new Promise(r => setTimeout(r, 200)); }
}
console.log(`\n${failed ? 'FAIL' : 'PASS'} x402-crash.test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
