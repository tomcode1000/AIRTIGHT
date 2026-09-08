#!/usr/bin/env node
/**
 * AIRTIGHT Deal Room — local server.
 *
 * Serves the Deal Room and wires its buttons to the real thing: it spawns the
 * actual buyer agent, SIGKILLs the actual process, and deletes the actual Sibyl
 * Memory database. Nothing here simulates anything.
 *
 * This must run locally. A published artifact is sandboxed and cannot reach
 * localhost, so the hosted copy of the page shows a seeded example instead.
 *
 *   . .\scripts\env.ps1            (PowerShell)   or   set -a; . ../.env; set +a
 *   node web/server.mjs            → http://localhost:4300
 *
 * The seller must be running separately: node seller/server.mjs 4021
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SibylDriver } from '../memory/driver-sibyl.mjs';
import { FileDriver } from '../memory/driver-file.mjs';
import { DealMemory, CAT } from '../memory/deals.mjs';
import { TaskMemory } from '../tasks/checkpoint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.DEAL_ROOM_PORT || 4300);
const RESOURCE = process.env.AIRTIGHT_RESOURCE || 'http://localhost:4021/report/42';
const USE_FILE = process.env.AIRTIGHT_MEMORY === 'file';
const DB = process.env.SIBYL_MEMORY_DB || path.join(os.homedir(), '.sibyl-memory', 'memory.db');

const newDriver = () => USE_FILE
  ? new FileDriver(process.env.AIRTIGHT_STORE || '.airtight-memory')
  : new SibylDriver({ bin: process.env.SIBYL_MCP_BIN || 'sibyl-memory-mcp', db: process.env.SIBYL_MEMORY_DB || null });

/* ── live state ──────────────────────────────────────────────────────── */
const state = {
  dealId: null,
  child: null,           // the running buyer process
  agent: 'idle',         // idle | running | killed | resuming | done | refused
  killAt: 'AT:IN_FLIGHT',
  log: [],
  settlements: 0,
  lastExit: null,
};

// Task Checkpointing runs alongside Payment Safety and shares nothing with it
// but the driver. Separate process, separate log, separate category.
const task = {
  id: 'nightly-import',
  child: null,
  status: 'idle',        // idle | running | held | killed | done | failed
  log: [],
  holdAt: 4,
  restarts: 0,
};

const clients = new Set();
const send = (type, data) => {
  const line = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const res of clients) { try { res.write(line); } catch {} }
};
const log = (text, kind = 'out') => {
  const entry = { t: new Date().toISOString().slice(11, 19), text, kind };
  state.log.push(entry);
  if (state.log.length > 400) state.log.shift();
  send('log', entry);
};
const setAgent = a => { state.agent = a; send('agent', { agent: a }); };

const tlog = (text, kind = 'out') => {
  const entry = { t: new Date().toISOString().slice(11, 19), text, kind };
  task.log.push(entry);
  if (task.log.length > 400) task.log.shift();
  send('tlog', entry);
};
const setTask = s => { task.status = s; send('tstatus', { status: s }); };

function runTask({ hold = null } = {}) {
  if (task.child) return { ok: false, error: 'the task is already running' };
  const env = { ...process.env, AIRTIGHT_STEP_MS: process.env.AIRTIGHT_STEP_MS || '1400' };
  const argv = [path.join(ROOT, 'tasks', 'demo-worker.mjs'), task.id];
  if (Number.isInteger(hold)) argv.push('--hold', String(hold));

  const child = spawn(process.execPath, argv, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  task.child = child;
  setTask('running');

  const kindOf = l =>
    l.startsWith('WROTE') ? 'good'
    : l.startsWith('RESUMED') || l.startsWith('SKIPPED') ? 'resume'
    : l.startsWith('HOLD') ? 'held'
    : l.startsWith('DONE') ? 'good'
    : 'out';

  const onData = d => {
    for (const raw of d.toString().split('\n')) {
      const line = raw.trimEnd();
      if (!line) continue;
      if (line.startsWith('HOLD')) setTask('held');
      tlog(line, kindOf(line));
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', d => onData(d));

  child.on('close', (code, signal) => {
    task.child = null;
    if (signal === 'SIGKILL' || signal === 'SIGTERM') { setTask('killed'); tlog('──── process killed ────', 'dead'); }
    else if (code === 0) setTask('done');
    else { setTask('failed'); tlog(`exited ${code}`, 'err'); }
    pushState();
  });
  return { ok: true, pid: child.pid };
}

/* ── spawn the real buyer ────────────────────────────────────────────── */
function runBuyer({ hold = null, resumeOnly = false } = {}) {
  if (state.child) return { ok: false, error: 'an agent is already running' };
  if (!process.env.DEMO_BUYER_KEY) return { ok: false, error: 'DEMO_BUYER_KEY is not set — load .env first' };

  const env = { ...process.env };
  if (hold) env.AIRTIGHT_HOLD_AT = hold; else delete env.AIRTIGHT_HOLD_AT;
  if (resumeOnly) env.AIRTIGHT_RESUME_ONLY = '1'; else delete env.AIRTIGHT_RESUME_ONLY;

  const child = spawn(process.execPath, [path.join(ROOT, 'buyer', 'agent.mjs'), RESOURCE, state.dealId], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.child = child;
  setAgent('running');
  send('deal', { dealId: state.dealId });

  const onData = kindOf => d => {
    for (const raw of d.toString().split('\n')) {
      const line = raw.trimEnd();
      if (!line) continue;
      if (line.includes('holding at')) { setAgent('held'); log(line, 'held'); continue; }
      log(line, kindOf(line));
      if (line.startsWith('AT:SETTLED') || line.startsWith('AT:RESETTLED')) state.settlements++;
    }
  };
  const kindOf = l =>
    l.startsWith('REFUSAL') || l.startsWith('BLOCKED') ? 'refusal'
    : l.startsWith('RESUMED') || l.startsWith('AT:CLOSED') || l.startsWith('AT:ATTESTED') ? 'good'
    : l.startsWith('AT:SETTLED') ? 'chain'
    : 'out';

  child.stdout.on('data', onData(kindOf));
  child.stderr.on('data', onData(() => 'err'));

  child.on('close', (code, signal) => {
    state.child = null;
    state.lastExit = { code, signal };
    if (signal === 'SIGKILL') { setAgent('killed'); log('──── process killed ────', 'dead'); }
    else if (code === 3) setAgent('refused');
    else if (code === 0) setAgent('done');
    else { setAgent('idle'); log(`agent exited ${code}`, 'err'); }
    pushState();
  });

  return { ok: true, pid: child.pid };
}

/* ── read the world ──────────────────────────────────────────────────── */
async function snapshot() {
  const driver = newDriver();
  const mem = new DealMemory(driver);
  const out = {
    dealId: state.dealId, agent: state.agent, killAt: state.killAt,
    settlements: state.settlements, resource: RESOURCE, db: DB,
    memory: { deal: 0, fp: 0, witness: 0, att: 0, task: 0, total: 0 },
    deal: null, buyer: null,
    task: { id: task.id, status: task.status, holdAt: task.holdAt, restarts: task.restarts, record: null, resumeFrom: 0 },
  };
  try {
    const [deals, fps, wits, atts, tasks] = await Promise.all([
      driver.list(CAT.DEAL), driver.list(CAT.FP), driver.list(CAT.WITNESS),
      driver.list(CAT.ATT), (new TaskMemory(driver)).list(),
    ]);
    out.memory = {
      deal: deals.length, fp: fps.length, witness: wits.length, att: atts.length,
      task: tasks.length,
      total: deals.length + fps.length + wits.length + atts.length,
    };

    const tmem = new TaskMemory(driver);
    const r = await tmem.resume(task.id);
    out.task.record = r.record;
    out.task.resumeFrom = r.resumeFrom;
    if (state.dealId) {
      const d = await mem.get(state.dealId);
      if (d) {
        out.deal = {
          state: d.state,
          transitions: d.transitions,
          terms_hash: d.terms_hash,
          merkle_root: d.disclosure?.merkle_root ?? null,
          payer: d.authorization?.payer ?? null,
          pay_to: d.terms?.pay_to ?? null,
          price: d.terms?.price_cap_usdc ?? null,
          network: d.terms?.network ?? null,
          fingerprint: d.payment?.fingerprint ?? null,
          tx_hash: d.payment?.tx_hash ?? null,
          nonce: d.payment?.x402?.authorization?.nonce ?? null,
          payload_sha256: d.delivery?.payload_sha256 ?? null,
          attested: !!(await mem.getAttestation(state.dealId, 'delivery')),
        };
      }
    }
  } catch (e) {
    out.error = e.message;
  } finally {
    driver.close?.();
  }
  return out;
}

let pushing = false;
async function pushState() {
  if (pushing) return;
  pushing = true;
  try { send('state', { state: await snapshot() }); } finally { pushing = false; }
}

/* ── http ────────────────────────────────────────────────────────────── */
const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readBody = req => new Promise(resolve => {
  let b = ''; req.on('data', c => b += c);
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // Both pages come off this server so everything is same-origin: the Deal Room
  // can call the API, and the overview's links stay local instead of bouncing
  // out to the hosted preview.
  const page = p === '/' || p === '/room' ? 'deal-room.html'
             : p === '/tasks' ? 'task-room.html'
             : p === '/slides' ? 'slides.html'
             : p === '/overview' || p === '/index.html' ? 'index.html'
             : null;
  if (page) {
    let html = fs.readFileSync(path.join(HERE, page), 'utf8');
    html = html.replace(/https:\/\/claude\.ai\/code\/artifact\/66be152e-6dbd-41cd-b120-3208e4370c65/g, '/room')
               .replace(/https:\/\/claude\.ai\/code\/artifact\/9fb4b586-f957-4331-90fe-c4cae3448623/g, '/tasks')
               .replace(/https:\/\/claude\.ai\/code\/artifact\/7113b353-9d86-4c1d-87ca-ecffcb9271f0/g, '/slides')
               .replace(/https:\/\/claude\.ai\/code\/artifact\/4f02f00f-5f88-45ea-a5a8-9f2e2ea979f4/g, '/overview');
    // Never cache. These pages are edited between takes, and a browser serving
    // a stale copy during a demo looks exactly like the change was never made.
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
    });
    return res.end(html);
  }

  // The mark, for the demo close card, posts, and anything that wants a file
  // rather than the inline copy in each page.
  if (p === '/logo.svg') {
    try {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(HERE, 'logo.svg')));
    } catch {
      res.writeHead(404); return res.end();
    }
  }

  if (p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    for (const e of state.log.slice(-60)) res.write(`data: ${JSON.stringify({ type: 'log', ...e })}\n\n`);
    for (const e of task.log.slice(-60)) res.write(`data: ${JSON.stringify({ type: 'tlog', ...e })}\n\n`);
    send('agent', { agent: state.agent });
    send('tstatus', { status: task.status });
    pushState();
    req.on('close', () => clients.delete(res));
    return;
  }

  if (p === '/api/state') return json(res, 200, await snapshot());

  if (p === '/api/start' && req.method === 'POST') {
    const body = await readBody(req);
    if (state.child) return json(res, 409, { ok: false, error: 'an agent is already running' });
    state.killAt = body.killAt || state.killAt;
    state.dealId = `dt-${Math.floor(Date.now() / 1000)}-${crypto.randomBytes(2).toString('hex')}`;
    state.settlements = 0;
    state.log = [];
    send('clear', {});
    log(`starting deal against ${RESOURCE}`, 'meta');
    const r = runBuyer({ hold: body.hold === false ? null : state.killAt });
    pushState();
    return json(res, r.ok ? 200 : 400, r);
  }

  if (p === '/api/kill' && req.method === 'POST') {
    if (!state.child) return json(res, 409, { ok: false, error: 'nothing is running' });
    const pid = state.child.pid;
    state.child.kill('SIGKILL');
    return json(res, 200, { ok: true, pid });
  }

  if (p === '/api/resume' && req.method === 'POST') {
    if (!state.dealId) return json(res, 409, { ok: false, error: 'no deal to resume' });
    log('cold restart — reading state from memory', 'meta');
    setAgent('resuming');
    const r = runBuyer({ hold: null, resumeOnly: true });
    pushState();
    return json(res, r.ok ? 200 : 400, r);
  }

  if (p === '/api/task/start' && req.method === 'POST') {
    const body = await readBody(req);
    if (task.child) return json(res, 409, { ok: false, error: 'the task is already running' });
    if (body.fresh) {
      // A finished task must not be "resumed" into completion again — a fresh
      // run means step 0, so the old record is cleared first.
      task.log = []; task.restarts = 0; send('tclear', {});
      const d = newDriver();
      try { await (new TaskMemory(d)).forget(task.id); } finally { d.close?.(); }
    } else task.restarts++;
    if (Number.isInteger(body.holdAt)) task.holdAt = body.holdAt;
    const r = runTask({ hold: body.hold === false ? null : task.holdAt });
    pushState();
    return json(res, r.ok ? 200 : 400, r);
  }

  if (p === '/api/task/kill' && req.method === 'POST') {
    if (!task.child) return json(res, 409, { ok: false, error: 'the task is not running' });
    const pid = task.child.pid;
    task.child.kill('SIGKILL');
    return json(res, 200, { ok: true, pid });
  }

  if (p === '/api/task/wipe' && req.method === 'POST') {
    // Deletes ONLY the task record. Payment records are a different category
    // and must be untouched — the page shows both counts to prove it.
    if (task.child) task.child.kill('SIGKILL');
    const driver = newDriver();
    try {
      const tmem = new TaskMemory(driver);
      await tmem.forget(task.id);
      tlog('task memory deleted — the next run starts from step 0', 'refusal');
    } finally { driver.close?.(); }
    task.restarts = 0;
    await pushState();
    return json(res, 200, { ok: true });
  }

  if (p === '/api/wipe' && req.method === 'POST') {
    if (state.child) state.child.kill('SIGKILL');
    let removed = 0;
    if (USE_FILE) {
      const dir = path.resolve(process.env.AIRTIGHT_STORE || '.airtight-memory');
      try { fs.rmSync(dir, { recursive: true, force: true }); removed++; } catch {}
    } else {
      for (const f of [DB, DB + '-wal', DB + '-shm']) {
        try { if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); removed++; } } catch {}
      }
    }
    log(`memory deleted — ${removed} file(s) removed`, 'refusal');
    log('the agent can no longer verify any deal', 'refusal');
    await pushState();
    return json(res, 200, { ok: true, removed });
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use — another Deal Room is running.\n`);
    console.error(`  stop it : taskkill //PID <pid> //F     (kill <pid> elsewhere)`);
    console.error(`  or run  : DEAL_ROOM_PORT=${PORT + 1} node web/server.mjs\n`);
    process.exit(1);
  }
  console.error('deal room failed:', e.message);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`AIRTIGHT Deal Room  ->  http://localhost:${PORT}`);
  console.log(`  seller   ${RESOURCE}`);
  console.log(`  memory   ${USE_FILE ? 'file:' + (process.env.AIRTIGHT_STORE || '.airtight-memory') : 'sibyl:' + DB}`);
  console.log(`  buyer    ${process.env.DEMO_BUYER_KEY ? 'key loaded' : 'NO KEY — run . .\\scripts\\env.ps1 first'}`);
});
