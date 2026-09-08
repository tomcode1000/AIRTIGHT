import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.JOBS_DIR = './data/jobs-test-server';
process.env.PAYMENT_MODE = 'stub';
delete process.env.LLM_BASE_URL; // force regex extractor

const { createServer } = await import('../src/server/server.js');
const jobs = await import('../src/orchestrator/jobs.js');

// Fake pipeline: instant, deterministic, no network.
const fakeRunnerCalls = [];
const fakePipeline = async (opts) => {
  fakeRunnerCalls.push(opts);
  const mk = (company, score, priority) => ({
    company_name: company, licensee_name: company, license_number: `LIC-${company}`,
    priority, signal_score: score, status: 'Current', percentage_drop: 60,
    permits2024: 10, permits2025: 4, phone: '305-555-0000', website: '',
    website_status: 'not_found', google_reviews: 0, google_rating: null,
    signals_detected: `Permit activity dropped 60% since 2024, Website Down / Not Found`,
    expiration_date: null, licensure_date: null, address: 'Miami', source_url: '',
  });
  return {
    gated: [{ ContractorName: 'X', percentageDrop: 60 }],
    scored: [
      { ...mk('ACME', 9, 'HIGH'), explanation: { summary: 'ACME flagged for 60% drop', reasons: [], suggested_action: 'Call first.' } },
      { ...mk('BETA', 4, 'MEDIUM'), explanation: { summary: 'BETA flagged for 60% drop', reasons: [], suggested_action: 'Worth a call.' } },
      { ...mk('GAMMA', 1, 'LOW'), explanation: { summary: 'GAMMA quiet', reasons: [], suggested_action: 'Monitor.' } },
    ],
    report: { subject: 'fake subject' },
    outFile: './out/fake/report.html',
    briefing: 'Scan complete: 2 HIGH/MEDIUM target(s).',
    errors: [],
  };
};

const server = createServer({ pipelineRunner: fakePipeline });
await new Promise((r) => server.listen(0, r)); // ephemeral port, no auto-bind
const base = `http://127.0.0.1:${server.address().port}`;

async function post(path, body) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const get = async (path) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
};

after(() => new Promise((r) => server.close(r)));

describe('intake server (integration)', () => {
  test('health + counties routes', async () => {
    const h = await get('/health');
    assert.equal(h.body.ok, true);
    const c = await get('/v1/counties');
    assert.equal(c.body.counties[0].key, 'MIAMI-DADE');
  });

  test('structured request: 202 ack → queued → completes with result', async () => {
    const ack = await post('/v1/requests', {
      requester_id: 'agent-A',
      county: 'miami-dade',
      callback_url: null,
    });
    assert.equal(ack.status, 202);
    assert.equal(ack.body.status, 'queued');

    // Poll until complete (fake runner resolves quickly)
    let job;
    for (let i = 0; i < 20; i++) {
      job = (await get(`/v1/requests/${ack.body.job_id}`)).body;
      if (job.status === 'complete') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(job.status, 'complete');
    assert.equal(job.result.highMedium, 2);
    assert.equal(fakeRunnerCalls[0].county, 'MIAMI-DADE'); // normalized
    assert.equal(fakeRunnerCalls[0].outSubdir, ack.body.job_id); // per-job output dir
  });

  test('NL request without county → 422 clarification, no run', async () => {
    const before = fakeRunnerCalls.length;
    const r = await post('/v1/requests', { requester_id: 'agent-B', message: 'find me roofers' });
    assert.equal(r.status, 422);
    assert.equal(r.body.code, 'needs_clarification');
    assert.equal(fakeRunnerCalls.length, before);
  });

  test('NL request with county runs through regex extractor', async () => {
    const r = await post('/v1/requests', {
      requester_id: 'agent-B',
      message: 'distressed HVAC contractors in Miami-Dade',
    });
    assert.equal(r.status, 202);
    let job;
    for (let i = 0; i < 20; i++) {
      job = (await get(`/v1/requests/${r.body.job_id}`)).body;
      if (job.status === 'complete') break;
      await new Promise((res) => setTimeout(res, 50));
    }
    assert.equal(job.status, 'complete');
    assert.equal(job.params.county, 'MIAMI-DADE');
  });

  test('manual payment mode → 402 needs_payment → admin confirm queues it', async () => {
    process.env.PAYMENT_MODE = 'manual';
    process.env.ADMIN_TOKEN = 'sekret';
    const { submitRequest, configurePipelineRunner } = await import('../src/orchestrator/orchestrator.js');
    const { createPaymentGate } = await import('../src/payment/gate.js');
    configurePipelineRunner(fakePipeline);

    // Direct orchestrator call with an explicit manual gate (server env already read at boot)
    const { status, body } = await submitRequest(
      { requester_id: 'agent-C', county: 'MIAMI-DADE' },
      createPaymentGate('manual')
    );
    assert.equal(status, 402);
    assert.equal(body.status, 'needs_payment');
    assert.ok(body.confirm_how.includes(body.job_id));

    // Confirm via admin HTTP endpoint
    const conf = await post(`/v1/admin/jobs/${body.job_id}/confirm-payment`, {});
    assert.equal(conf.status, 401); // token header missing

    const confOk = await fetch(`${base}/v1/admin/jobs/${body.job_id}/confirm-payment`, {
      method: 'POST',
      headers: { Authorization: 'Bearer sekret' },
    });
    assert.equal(confOk.status, 202);

    let job;
    for (let i = 0; i < 20; i++) {
      job = (await get(`/v1/requests/${body.job_id}`)).body;
      if (job.status === 'complete') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(job.status, 'complete');

    process.env.ADMIN_TOKEN = '';
    process.env.PAYMENT_MODE = 'stub'; // restore for later tests
  });

  test('Phase 4: x402-mock flow: 402 challenge → paid retry → settle receipt; standing client bypasses', async () => {
    process.env.PAYMENT_MODE = 'x402-mock';
    process.env.X402_PAY_TO = '0xABC0000000000000000000000000000000000abc';
    process.env.X402_PRICE_USDC = '25';

    // 1. Unpaid request → 402 with accepts requirements
    const unpaid = await fetch(`${base}/v1/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requester_id: 'agent-x402', county: 'MIAMI-DADE' }),
    });
    assert.equal(unpaid.status, 402);
    const challenge = await unpaid.json();
    assert.equal(challenge.accepts[0].scheme, 'exact');
    assert.equal(challenge.accepts[0].maxAmountRequired, '25000000');

    // 2. Retry with X-PAYMENT header (mock-valid) → 202 + settlement receipt
    const paymentHeader = Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: 'exact',
        network: 'base-sepolia',
        payload: {
          signature: '0xsig',
          authorization: { from: '0xclientwallet', to: challenge.accepts[0].payTo, value: '25000000' },
        },
      })
    ).toString('base64');
    const paid = await fetch(`${base}/v1/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PAYMENT': paymentHeader },
      body: JSON.stringify({ requester_id: 'agent-x402', county: 'MIAMI-DADE' }),
    });
    assert.equal(paid.status, 202);
    assert.ok(paid.headers.get('x-payment-response'));
    const paidBody = await paid.json();
    assert.equal(paidBody.settlement.success, true);
    assert.equal(paidBody.settlement.payer, '0xclientwallet');

    // malformed header → 402 with error
    const bad = await fetch(`${base}/v1/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PAYMENT': Buffer.from('junk').toString('base64') },
      body: JSON.stringify({ requester_id: 'agent-x402', county: 'MIAMI-DADE' }),
    });
    assert.equal(bad.status, 402);
    assert.ok((await bad.json()).error.includes('malformed'));

    // standing client skips the 402 entirely
    const standing = await post('/v1/requests', { requester_id: 'larry', county: 'MIAMI-DADE' });
    assert.equal(standing.status, 202);

    process.env.PAYMENT_MODE = 'stub';
  });

  test('missing requester_id → 400', async () => {
    const r = await post('/v1/requests', { county: 'MIAMI-DADE' });
    assert.equal(r.status, 400);
  });

  test('Phase 3: ask endpoint answers from delivered records', async () => {
    // Run a fresh job to completion
    const ack = await post('/v1/requests', { requester_id: 'agent-D', county: 'MIAMI-DADE' });
    assert.equal(ack.status, 202);
    let job;
    for (let i = 0; i < 20; i++) {
      job = (await get(`/v1/requests/${ack.body.job_id}`)).body;
      if (job.status === 'complete') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(job.status, 'complete');
    assert.ok(job.result.briefing.includes('Scan complete'));
    assert.equal(job.result.records.length, 3);

    // why is ACME flagged
    const ask1 = await post(`/v1/requests/${ack.body.job_id}/ask`, { question: 'why is ACME flagged?' });
    assert.equal(ask1.status, 200);
    assert.ok(ask1.body.answer.includes('ACME'));
    assert.ok(ask1.body.answer.includes('60%'));

    // call-first ordering
    const ask2 = await post(`/v1/requests/${ack.body.job_id}/ask`, { question: 'who should I call first?' });
    assert.ok(ask2.body.answer.includes('1. ACME'));

    // contact info
    const ask3 = await post(`/v1/requests/${ack.body.job_id}/ask`, { question: 'contact info for BETA' });
    assert.ok(ask3.body.answer.includes('305-555-0000'));

    // missing question → 400
    const ask4 = await post(`/v1/requests/${ack.body.job_id}/ask`, {});
    assert.equal(ask4.status, 400);

    // unknown job → 404
    const ask5 = await post('/v1/requests/req_20990101_ffffffff/ask', { question: 'hi' });
    assert.equal(ask5.status, 404);
  });
});
