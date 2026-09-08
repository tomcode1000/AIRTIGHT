import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.CREDITS_FILE = './data/credits-test.json';
process.env.JOBS_DIR = './data/jobs-test-credits';
process.env.PAYMENT_MODE = 'stub';
process.env.X402_PRICE_USDC = '25';
process.env.JOB_MAX_ATTEMPTS = '2';
delete process.env.LLM_BASE_URL; // force regex extractor

const credits = await import('../src/payment/credits.js');
const { submitRequest, configurePipelineRunner } = await import(
  '../src/orchestrator/orchestrator.js'
);
const jobs = await import('../src/orchestrator/jobs.js');

function resetLedger() {
  try { fs.unlinkSync('./data/credits-test.json'); } catch {}
}

/** Poll a job until it leaves the active set (or timeout). */
async function waitFor(jobId, statuses, timeoutMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const j = jobs.getJob(jobId);
    if (j && statuses.includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`job ${jobId} never reached ${statuses.join('/')}`);
}

describe('credits ledger', () => {
  test('add → balance → consume → persist round-trip', () => {
    resetLedger();
    assert.equal(credits.getBalance('0xABC'), 0);

    credits.addCredit('0xABC', 25, 'job_1', 'refund: terminal pipeline failure');
    credits.addCredit('0xABC', 5, null, 'manual comp');
    assert.equal(credits.getBalance('0xABC'), 30);
    assert.equal(credits.getBalance('0xabc'), 30); // case-insensitive key

    const r = credits.consumeCredit('0xABC', 25);
    assert.equal(r.ok, true);
    assert.equal(r.used, 25);
    assert.equal(r.remaining, 5);
    assert.equal(credits.getBalance('0xABC'), 5);

    // persisted to disk (fresh read through the same module cache path)
    const raw = JSON.parse(fs.readFileSync('./data/credits-test.json', 'utf8'));
    assert.equal(raw['0xabc'].balance, 5);
    assert.ok(raw['0xabc'].history.some((h) => h.reason === 'refund: terminal pipeline failure'));
  });

  test('consume more than balance consumes what exists, then fails', () => {
    resetLedger();
    credits.addCredit('0xPartial', 10, null, 'test');
    const r = credits.consumeCredit('0xPartial', 25);
    assert.equal(r.ok, true);
    assert.equal(r.used, 10);
    assert.equal(credits.consumeCredit('0xPartial', 1).ok, false);
  });

  test('creditsOverview: single payer + whole ledger', () => {
    resetLedger();
    credits.addCredit('0xView', 25, 'job_x', 'test');
    const one = credits.creditsOverview('0xView');
    assert.equal(one.balance, 25);
    const all = credits.creditsOverview();
    assert.ok(all['0xview']);
  });
});

describe('paid-run retry + refund policy', () => {
  test('transient failure retries, then completes', async () => {
    let calls = 0;
    configurePipelineRunner(async () => {
      calls += 1;
      if (calls === 1) throw new Error('portal blip');
      return { gated: [], scored: [{ priority: 'HIGH', signal_score: 50 }], report: { subject: 'ok' }, outFile: 'x', briefing: 'b', errors: [] };
    });
    const r = await submitRequest({ requester_id: 'retry-guy', county: 'MIAMI-DADE' });
    assert.equal(r.status, 202);
    const job = await waitFor(r.body.job_id, ['complete']);
    assert.equal(job.attempts, 2);
    assert.equal(calls, 2);
  });

  test('terminal failure after retries → failed + full-price credit to payer', async () => {
    resetLedger();
    configurePipelineRunner(async () => {
      throw new Error('portal is down');
    });
    const payer = '0xabcdef12345678900000000000000000000fedcba';
    const r = await submitRequest({ requester_id: 'doomed', county: 'MIAMI-DADE', payment_ref: payer });
    assert.equal(r.status, 202);
    const job = await waitFor(r.body.job_id, ['failed']);
    assert.match(job.error, /portal is down/);
    assert.equal(job.attempts, 2);
    assert.equal(credits.getBalance(payer), credits.creditPriceUsdc());
    const view = credits.creditsOverview(payer);
    assert.ok(view.history.some((h) => h.reason.startsWith('refund:')));
  });

  test('service credit pays for the NEXT request without settlement', async () => {
    resetLedger();
    // manual mode gate would normally 402: a credit covers it instead
    process.env.PAYMENT_MODE = 'manual';
    try {
      configurePipelineRunner(async () => ({ gated: [], scored: [], report: { subject: 's' }, outFile: 'x', briefing: 'b', errors: [] }));
      const payer = '0xCreditUser0000000000000000000000000001';
      credits.addCredit(payer, 25, null, 'prior refund');

      const r = await submitRequest({ requester_id: 'creditor', county: 'MIAMI-DADE', payment_ref: payer });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      assert.match(r.body.message, /service credit/);
      assert.equal(credits.getBalance(payer), 0);
      const job = await waitFor(r.body.job_id, ['complete']);
      assert.equal(job.status, 'complete');

      // credit exhausted → back to needs_payment
      const r2 = await submitRequest({ requester_id: 'creditor', county: 'MIAMI-DADE', payment_ref: payer });
      assert.equal(r2.status, 402);
    } finally {
      process.env.PAYMENT_MODE = 'stub';
    }
  });
});

describe('discovery manifest', () => {
  test('GET /v1/schema exposes lanes, payment flow and endpoints', async () => {
    const { createServer } = await import('../src/server/server.js');
    configurePipelineRunner(async () => ({ scored: [], report: {}, errors: [] }));
    const server = createServer();
    await new Promise((r) => server.listen(0, r));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const res = await fetch(`${base}/v1/schema`);
      assert.equal(res.status, 200);
      const doc = await res.json();
      assert.equal(doc.payment.protocol, 'x402');
      assert.equal(doc.payment.flow.length, 4);
      assert.ok(doc.lanes.scan.counties.includes('70'));
      assert.ok(doc.endpoints.some((e) => e.path === '/v1/requests'));
      assert.match(doc.payment.refunds, /credits?/i);

      const wellKnown = await fetch(`${base}/.well-known/x402-service.json`);
      assert.equal(wellKnown.status, 200);

      // admin credits route requires the bearer token
      const noAuth = await fetch(`${base}/v1/admin/credits`);
      assert.equal(noAuth.status, 401);
      process.env.ADMIN_TOKEN = 'testtoken';
      const auth = await fetch(`${base}/v1/admin/credits`, {
        headers: { Authorization: 'Bearer testtoken' },
      });
      assert.equal(auth.status, 200);
      delete process.env.ADMIN_TOKEN;
    } finally {
      server.close();
    }
  });
});
