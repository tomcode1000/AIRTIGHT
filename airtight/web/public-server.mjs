/**
 * AIRTIGHT public test server.
 *
 * This is the internet-facing sibling of web/server.mjs. That one is a private
 * control room: it assumes one trusted operator, keeps one global run, and
 * exposes endpoints that delete memory. None of that is safe to publish.
 *
 * What is different here, and why:
 *
 *   1. Every visitor gets their own run. The private server keeps a single
 *      `state.child`, so two people pressing Run at the same moment would fight
 *      over one deal and watch each other's payment. Runs here are a registry
 *      keyed by an unguessable id, and a visitor can only touch their own.
 *
 *   2. Nothing destructive is reachable. There is no wipe, no store path, no
 *      argument taken from the request that reaches a process. The only spawn
 *      arguments are ids this server generated.
 *
 *   3. Spending is capped in four independent ways, because the buyer key lives
 *      on this machine and every completed payment run costs real money: per
 *      IP, per day, by concurrency, and by a floor on the wallet balance read
 *      from the chain. Any one of them saying no is a refusal.
 *
 *   4. The wallet balance is checked against the chain, not against a counter
 *      this process keeps, so a restart cannot forget what has been spent.
 *
 * The task module is free to run, so it is capped only to protect the CPU.
 *
 * Env: X402_NETWORK, X402_PRICE_USDC, DEMO_BUYER_ADDRESS, DEMO_BUYER_KEY,
 *      PUBLIC_PORT, PUBLIC_PAY_PER_IP, PUBLIC_PAY_PER_DAY, PUBLIC_TRUST_PROXY
 */
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SibylDriver } from '../memory/driver-sibyl.mjs';
import { FileDriver } from '../memory/driver-file.mjs';
import { DealMemory } from '../memory/deals.mjs';

const newDriver = () => process.env.AIRTIGHT_MEMORY === 'file'
  ? new FileDriver(process.env.AIRTIGHT_STORE || '.airtight-memory')
  : new SibylDriver({ bin: process.env.SIBYL_MCP_BIN || 'sibyl-memory-mcp', db: process.env.SIBYL_MEMORY_DB || null });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// Railway (and most hosts) hand the port in PORT and expect the app to use it.
const PORT = Number(process.env.PORT || process.env.PUBLIC_PORT || 4400);
const RESOURCE = process.env.AIRTIGHT_RESOURCE || 'http://localhost:4021/report/42';

const NETWORK = process.env.X402_NETWORK || 'base-sepolia';
const PRICE = Number(process.env.X402_PRICE_USDC || 0.01);
const BUYER = process.env.DEMO_BUYER_ADDRESS || '';

const RPC = {
  base: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
  'base-sepolia': process.env.BASE_RPC_URL || 'https://sepolia.base.org',
};
const USDC = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};
const EXPLORER = {
  base: 'https://basescan.org/tx/',
  'base-sepolia': 'https://sepolia.basescan.org/tx/',
};

/* ── caps ─────────────────────────────────────────────────────────────
   Deliberately low. A public page that runs dry in an hour is worse than
   one that paces itself, and the whole budget is a single dollar. */
const CAP = {
  payPerIpPerHour:  Number(process.env.PUBLIC_PAY_PER_IP  || 2),
  payPerDay:        Number(process.env.PUBLIC_PAY_PER_DAY || 40),
  payConcurrent:    2,
  taskPerIpPerHour: 6,
  taskPerDay:       300,
  taskConcurrent:   3,
  // Stop paying while there is still enough left to prove the point on camera.
  balanceFloor:     PRICE * 10,
  // When we are our own facilitator the settler pays gas, and running out of
  // gas fails a run halfway rather than refusing it up front. A settlement
  // costs roughly 0.0000225 ETH on Base, so this holds back about two.
  gasFloorEth:      Number(process.env.PUBLIC_GAS_FLOOR_ETH || 0.00005),
  runTtlMs:         3 * 60 * 1000,
};

/* ── rate accounting ──────────────────────────────────────────────────
   In memory on purpose: a restart is not a way to get more budget, because
   the balance floor below is read from the chain and is the real limit. */
const hits = new Map();                 // `${ip}:${kind}` -> number[] of timestamps
const day = { stamp: today(), pay: 0, task: 0 };
function today() { return new Date().toISOString().slice(0, 10); }
function rollDay() {
  const t = today();
  if (day.stamp !== t) { day.stamp = t; day.pay = 0; day.task = 0; }
}
function noteIp(ip, kind) {
  const key = `${ip}:${kind}`;
  const now = Date.now();
  const keep = (hits.get(key) || []).filter(t => now - t < 3600_000);
  keep.push(now);
  hits.set(key, keep);
  return keep.length;
}
function ipCount(ip, kind) {
  const now = Date.now();
  return (hits.get(`${ip}:${kind}`) || []).filter(t => now - t < 3600_000).length;
}

// Behind a proxy the socket address is the proxy, so the client address has to
// come from the forwarding header. That header is trivially spoofed by anyone
// talking to this server directly, so it is only honoured when the operator has
// said there really is a proxy in front.
const TRUST_PROXY = process.env.PUBLIC_TRUST_PROXY === '1';
function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

/* ── wallet balance, read from the chain ──────────────────────────────── */
let balance = { usdc: null, at: 0, error: null };
async function usdcBalance() {
  if (!BUYER) return { usdc: null, error: 'DEMO_BUYER_ADDRESS is not set' };
  if (Date.now() - balance.at < 30_000) return balance;
  const data = '0x70a08231' + BUYER.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  try {
    const r = await fetch(RPC[NETWORK] || RPC['base-sepolia'], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: USDC[NETWORK] || USDC['base-sepolia'], data }, 'latest'] }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    balance = { usdc: Number(BigInt(j.result)) / 1e6, at: Date.now(), error: null };
  } catch (e) {
    // An unreachable RPC is not evidence of an empty wallet, but it is also not
    // evidence of a funded one. Payments stop until it answers again.
    balance = { usdc: null, at: Date.now(), error: e.message };
  }
  return balance;
}

/* ── the settler's gas, when we are our own facilitator ────────────────
   A hosted facilitator pays its own gas, so this only applies when the
   facilitator URL points back at this machine. Checking it otherwise would
   refuse runs over a wallet that is never used. */
const SETTLER = process.env.FACILITATOR_ADDRESS || '';
const OWN_FACILITATOR = /localhost|127\.0\.0\.1|\[::1\]/.test(process.env.X402_FACILITATOR_URL || '');

let gas = { eth: null, at: 0, error: null };
async function settlerGas() {
  if (!OWN_FACILITATOR || !SETTLER) return { eth: null, error: null, skip: true };
  if (Date.now() - gas.at < 30_000) return gas;
  try {
    const r = await fetch(RPC[NETWORK] || RPC['base-sepolia'], {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [SETTLER, 'latest'] }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    gas = { eth: Number(BigInt(j.result)) / 1e18, at: Date.now(), error: null };
  } catch (e) {
    gas = { eth: null, at: Date.now(), error: e.message };
  }
  return gas;
}

/* ── run registry ─────────────────────────────────────────────────────── */
const runs = new Map();
const live = kind => [...runs.values()].filter(r => r.kind === kind && r.child).length;

function newRun(kind, ip) {
  const id = crypto.randomBytes(16).toString('hex');   // unguessable: it is the only authority over the run
  const run = {
    id, kind, ip,
    ref: kind === 'pay' ? `pub-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`
                        : `pub-task-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
    phase: 'starting',
    child: null, clients: new Set(), facts: {}, steps: [],
    born: Date.now(), paid: false,
  };
  runs.set(id, run);
  return run;
}

function emit(run, type, data = {}) {
  const line = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const res of run.clients) { try { res.write(line); } catch {} }
}
function setPhase(run, phase) { run.phase = phase; emit(run, 'phase', { phase }); }
function fact(run, k, v) { run.facts[k] = v; emit(run, 'fact', { k, v }); }
function step(run, name, note) {
  const s = { name, note: note || '', at: Date.now() };
  run.steps.push(s);
  emit(run, 'step', s);
}

/* ── translating agent output into the few things worth showing ────────
   The private room streams raw stdout. Here only the beats that carry the
   argument are surfaced: what was written, when it died, what it did on wake. */
function readPayLine(run, line) {
  const [head, ...rest] = line.split(' ');
  const tail = rest.join(' ');

  if (head.startsWith('AT:')) {
    const st = head.slice(3);
    step(run, st, st === 'IN_FLIGHT' ? 'authorisation stored before any money moves' : '');
    if (st === 'IN_FLIGHT') {
      const m = tail.match(/nonce (\w+)/);
      if (m) fact(run, 'nonce', m[1]);
      setPhase(run, 'armed');            // the dangerous moment: safe to kill now
    }
    if (st === 'PAID') { run.paid = true; setPhase(run, 'paid'); }
    return;
  }
  if (head === 'RESUMED')    { step(run, 'RESUME', tail); setPhase(run, 'resuming'); return; }
  if (head === 'RECONCILE')  { step(run, 'RECONCILE', 'the payment had already landed'); return; }
  if (head === 'VERIFIED')   { fact(run, 'verified', tail); return; }
  if (head === 'REFUSAL')    { step(run, 'REFUSAL', tail); setPhase(run, 'refused'); return; }
  if (head === 'BLOCKED')    { step(run, 'BLOCKED', tail); setPhase(run, 'refused'); return; }
  if (head === 'DONE')       { setPhase(run, 'done'); return; }

  const tx = line.match(/0x[0-9a-fA-F]{64}/);
  if (tx && /tx|hash|settle/i.test(line)) fact(run, 'tx', tx[0]);
}

function readTaskLine(run, line) {
  const [head, ...rest] = line.split(' ');
  const tail = rest.join(' ');
  if (head === 'WROTE')   { step(run, 'checkpoint', tail); return; }
  if (head === 'RESUMED') { step(run, 'resumed', tail); setPhase(run, 'resuming'); return; }
  if (head === 'SKIPPED') { step(run, 'skipped', tail); return; }
  if (head === 'HOLD')    { setPhase(run, 'armed'); return; }
  if (head === 'DONE')    { setPhase(run, 'done'); return; }
}

/* ── spawning ─────────────────────────────────────────────────────────── */
function spawnPay(run, { resume = false } = {}) {
  const env = { ...process.env };
  if (resume) { env.AIRTIGHT_RESUME_ONLY = '1'; delete env.AIRTIGHT_HOLD_AT; }
  else { env.AIRTIGHT_HOLD_AT = 'AT:IN_FLIGHT'; delete env.AIRTIGHT_RESUME_ONLY; }

  // Only ids this server generated ever reach argv.
  const child = spawn(process.execPath, [path.join(ROOT, 'buyer', 'agent.mjs'), RESOURCE, run.ref],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  attach(run, child, readPayLine);
  setPhase(run, resume ? 'resuming' : 'running');
}

function spawnTask(run, { resume = false } = {}) {
  const env = { ...process.env, AIRTIGHT_STEP_MS: process.env.AIRTIGHT_STEP_MS || '900' };
  const argv = [path.join(ROOT, 'tasks', 'demo-worker.mjs'), run.ref];
  if (!resume) argv.push('--hold', '4');
  const child = spawn(process.execPath, argv, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  attach(run, child, readTaskLine);
  setPhase(run, resume ? 'resuming' : 'running');
}

function attach(run, child, reader) {
  run.child = child;
  const onData = d => {
    for (const raw of d.toString().split('\n')) {
      const line = raw.trim();
      if (line) reader(run, line);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('close', async (code, signal) => {
    run.child = null;
    if (signal) { setPhase(run, 'killed'); emit(run, 'killed', {}); return; }
    if (run.kind === 'pay') await finaliseP(run);
    if (code !== 0 && run.phase !== 'refused') setPhase(run, 'failed');
    else if (run.phase !== 'refused' && run.phase !== 'done') setPhase(run, 'done');
  });
}

/**
 * The agent prints an abbreviated hash, which is right for a terminal and no use
 * to someone who wants to open the explorer. The full one is in the record, so
 * it is read back from storage once the run is over rather than reconstructed.
 */
async function finaliseP(run) {
  if (run.facts.tx) return;
  try {
    // Reading the record spins up the memory process, which takes a few seconds,
    // so the page is told to expect it rather than left showing an empty row.
    fact(run, 'tx', 'pending');
    const got = await lookup(run.ref);
    if (got?.tx) fact(run, 'tx', got.tx);
    else fact(run, 'tx', 'none');
    if (got?.state) fact(run, 'state', got.state);
  } catch (e) {
    fact(run, 'tx', 'none');
    console.error('finalise failed:', e.message);
  }
}

/** Read one deal in its own process, with a hard timeout. */
function lookup(ref) {
  return new Promise(resolve => {
    let out = '', settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };
    const child = spawn(process.execPath, [path.join(HERE, 'tx-of.mjs'), ref],
      { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} done(null); }, 20000);
    child.stdout.on('data', d => { out += d; });
    child.on('error', () => { clearTimeout(timer); done(null); });
    child.on('close', () => {
      clearTimeout(timer);
      try { done(JSON.parse(out.trim() || 'null')); } catch { done(null); }
    });
  });
}

// Nothing is allowed to sit holding a process forever.
setInterval(() => {
  const now = Date.now();
  for (const [id, run] of runs) {
    if (now - run.born > CAP.runTtlMs) {
      if (run.child) try { run.child.kill('SIGKILL'); } catch {}
      for (const res of run.clients) try { res.end(); } catch {}
      runs.delete(id);
    }
  }
  rollDay();
}, 20_000).unref();

/* ── admission ────────────────────────────────────────────────────────
   Four independent limits. Any one of them saying no is a refusal, and the
   balance floor is the only one a restart cannot reset, because it is read
   from the chain rather than kept in this process. */
async function admit(kind, ip) {
  rollDay();
  if (kind === 'pay') {
    if (!process.env.DEMO_BUYER_KEY) return 'the demo wallet is not configured';
    if (live('pay') >= CAP.payConcurrent) return 'another payment run is in flight, try again in a moment';
    if (ipCount(ip, 'pay') >= CAP.payPerIpPerHour) return `you have used this ${CAP.payPerIpPerHour} times in the last hour`;
    if (day.pay >= CAP.payPerDay) return 'the daily demo budget is spent, it resets at midnight UTC';
    const b = await usdcBalance();
    if (b.error) return 'cannot read the demo wallet balance right now';
    if (b.usdc < CAP.balanceFloor) return 'the demo wallet is out of funds';
    // Gas is a separate way to run dry, and on mainnet it runs out long before
    // the USDC does. Refuse up front rather than fail a run at settle time.
    const g = await settlerGas();
    if (!g.skip) {
      if (g.error) return 'cannot read the settlement wallet right now';
      if (g.eth < CAP.gasFloorEth) return 'the settlement wallet is out of gas';
    }
    return null;
  }
  if (live('task') >= CAP.taskConcurrent) return 'a few tasks are already running, try again in a moment';
  if (ipCount(ip, 'task') >= CAP.taskPerIpPerHour) return `you have used this ${CAP.taskPerIpPerHour} times in the last hour`;
  if (day.task >= CAP.taskPerDay) return 'the daily limit is spent, it resets at midnight UTC';
  return null;
}

/* ── http ─────────────────────────────────────────────────────────────── */
const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const body = req => new Promise(resolve => {
  let b = ''; let over = false;
  req.on('data', c => { b += c; if (b.length > 4096) { over = true; req.destroy(); } });
  req.on('end', () => { try { resolve(over ? {} : JSON.parse(b || '{}')); } catch { resolve({}); } });
  req.on('error', () => resolve({}));
});
// The run id is the only credential, so a caller may only reach their own run.
const own = (req, url) => {
  const m = url.pathname.match(/^\/api\/run\/([0-9a-f]{32})\/(events|kill|wake)$/);
  if (!m) return null;
  const run = runs.get(m[1]);
  if (!run || run.ip !== clientIp(req)) return null;
  return { run, action: m[2] };
};

/**
 * The hosted landing page is the same file the private one serves, with the two
 * operator rooms taken out.
 *
 * Those rooms drive a single global run and can delete the store, so they are
 * for one trusted person at a keyboard, not for the internet. Every link that
 * pointed at them now points at the bench, which is the thing a visitor can
 * safely press. One file, two audiences, rather than a second copy that drifts.
 */
const OVERVIEW  = 'https://claude.ai/code/artifact/4f02f00f-5f88-45ea-a5a8-9f2e2ea979f4';
const DEAL_ROOM = 'https://claude.ai/code/artifact/66be152e-6dbd-41cd-b120-3208e4370c65';
const TASK_ROOM = 'https://claude.ai/code/artifact/9fb4b586-f957-4331-90fe-c4cae3448623';
function publicise(html) {
  return html
    // the nav offered one pill per room; one bench replaces both
    .replaceAll(`<a class="cta two" href="${TASK_ROOM}">Task Room <span class="ar">&rarr;</span></a>`, '')
    .replaceAll(`<a class="cta" href="${DEAL_ROOM}">Deal Room <span class="ar">&rarr;</span></a>`,
             '<a class="cta" href="/try">Try it live <span class="ar">&rarr;</span></a>')
    .replaceAll(`<a class="btn primary" href="${DEAL_ROOM}">Open the Deal Room</a>`,
             '<a class="btn primary" href="/try">Try it live</a>')
    .replaceAll(`<a class="btn two" href="${TASK_ROOM}">Open the Task Room</a>`, '')
    .replaceAll(`<a href="${DEAL_ROOM}">Open the Deal Room &rarr;</a>`, '<a href="/try">Try it live &rarr;</a>')
    .replaceAll(`<a href="${TASK_ROOM}">Open the Task Room &rarr;</a>`, '<a href="/try">Try it live &rarr;</a>')
    // anything left over, including the deck, must not escape to the internet
    // the brand mark links to the page it is on
    .replaceAll(OVERVIEW, '/')
    .replaceAll(DEAL_ROOM, '/try')
    .replaceAll(TASK_ROOM, '/try')
    // a link whose href was swapped but whose label still names a private room
    // would send visitors somewhere the words do not match
    .replaceAll('Open the Deal Room', 'Try it live')
    .replaceAll('Open the Task Room', 'Try it live');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const ip = clientIp(req);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (p === '/' || p === '/index.html') {
    const html = publicise(await readFile(path.join(HERE, 'index.html'), 'utf8'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }
  if (p === '/try') {
    const html = await readFile(path.join(HERE, 'try.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }
  if (p === '/logo.svg') {
    const svg = await readFile(path.join(HERE, 'logo.svg'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end(svg);
  }

  if (p === '/api/status') {
    const b = await usdcBalance();
    return json(res, 200, {
      network: NETWORK, price: PRICE, explorer: EXPLORER[NETWORK] || EXPLORER['base-sepolia'],
      wallet: b.usdc == null ? null : Number(b.usdc.toFixed(4)),
      funded: b.usdc != null && b.usdc >= CAP.balanceFloor,
      gas: (await settlerGas()).eth,
      payLeftToday: Math.max(0, CAP.payPerDay - day.pay),
      yourPayLeft: Math.max(0, CAP.payPerIpPerHour - ipCount(ip, 'pay')),
      yourTaskLeft: Math.max(0, CAP.taskPerIpPerHour - ipCount(ip, 'task')),
    });
  }

  if (p === '/api/run' && req.method === 'POST') {
    const { module: mod } = await body(req);
    const kind = mod === 'task' ? 'task' : mod === 'pay' ? 'pay' : null;
    if (!kind) return json(res, 400, { error: 'unknown module' });

    const refusal = await admit(kind, ip);
    if (refusal) return json(res, 429, { error: refusal });

    noteIp(ip, kind);
    if (kind === 'pay') day.pay++; else day.task++;

    const run = newRun(kind, ip);
    if (kind === 'pay') spawnPay(run); else spawnTask(run);
    return json(res, 200, { id: run.id, ref: run.ref });
  }

  const scoped = own(req, url);
  if (scoped) {
    const { run, action } = scoped;
    if (action === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello', phase: run.phase, steps: run.steps, facts: run.facts })}\n\n`);
      run.clients.add(res);
      req.on('close', () => run.clients.delete(res));
      return;
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    if (action === 'kill') {
      if (!run.child) return json(res, 409, { error: 'nothing is running' });
      run.child.kill('SIGKILL');
      return json(res, 200, { ok: true });
    }
    if (action === 'wake') {
      if (run.child) return json(res, 409, { error: 'it is still running' });
      run.steps.push({ name: '───', note: 'cold start, no shared memory with the dead process', at: Date.now() });
      emit(run, 'step', run.steps.at(-1));
      if (run.kind === 'pay') spawnPay(run, { resume: true }); else spawnTask(run, { resume: true });
      return json(res, 200, { ok: true });
    }
  }

  json(res, 404, { error: 'not found' });
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') { console.error(`\nPort ${PORT} is already in use.\n`); process.exit(1); }
  throw e;
});

server.listen(PORT, async () => {
  const b = await usdcBalance();
  console.log(`\nAIRTIGHT public test page -> http://localhost:${PORT}`);
  console.log(`  network  ${NETWORK}`);
  console.log(`  price    ${PRICE} USDC per run`);
  console.log(`  wallet   ${b.usdc == null ? 'unreadable: ' + b.error : b.usdc.toFixed(4) + ' USDC'}`);
  console.log(`  caps     ${CAP.payPerIpPerHour}/ip/hour, ${CAP.payPerDay}/day, floor ${CAP.balanceFloor} USDC\n`);
});
