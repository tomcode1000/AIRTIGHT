/**
 * One command that brings up the whole hosted site.
 *
 * Railway runs a single process, but the site needs three: the seller that
 * issues the 402 challenge, the facilitator that settles it, and the public
 * server that visitors actually reach. This starts all three, keeps the public
 * one on the port the host assigned, and makes sure that if any of them dies
 * the container dies with it.
 *
 * That last part matters. A supervisor that quietly restarts a dead seller, or
 * keeps serving after the facilitator has gone, would leave visitors pressing a
 * button that can never settle. Failing loudly gets the host to restart the
 * whole thing, which is the behaviour you want.
 *
 * Only the public server is exposed. The seller and the facilitator listen on
 * localhost, and nothing outside the container can reach them.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const SELLER_PORT = process.env.SELLER_PORT || '4021';
const FAC_PORT = process.env.FACILITATOR_PORT || '4402';
const PUBLIC_PORT = process.env.PORT || '4400';

// Behind Railway's router the socket address is the proxy, so the forwarding
// header is the only way to tell visitors apart for rate limiting.
process.env.PUBLIC_TRUST_PROXY ??= '1';
process.env.AIRTIGHT_RESOURCE ??= `http://127.0.0.1:${SELLER_PORT}/report/42`;
process.env.SIBYL_MEMORY_DB ??= '/tmp/airtight-memory.db';
process.env.FACILITATOR_PORT = FAC_PORT;

const required = ['DEMO_BUYER_KEY', 'DEMO_BUYER_ADDRESS', 'X402_PAY_TO'];
if (process.env.X402_FACILITATOR_URL?.includes('localhost') ||
    process.env.X402_FACILITATOR_URL?.includes('127.0.0.1')) {
  required.push('FACILITATOR_KEY');
}
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`\nMissing required variables: ${missing.join(', ')}`);
  console.error('Set them in the host\'s environment, not in a file.\n');
  process.exit(1);
}

/**
 * Say what is wrong at boot rather than at the first button press.
 *
 * A container that starts and then fails the moment someone tries to record
 * something is far harder to diagnose than one that refuses to start, and the
 * memory backend is a separate runtime that a Node-only build would leave out
 * entirely. Checking it here turns that into one clear line in the deploy log.
 */
const mcp = process.env.SIBYL_MCP_BIN || 'sibyl-memory-mcp';
if (process.env.AIRTIGHT_MEMORY !== 'file') {
  // A bare name is resolved through PATH when it is spawned; only an explicit
  // path can be checked here.
  const named = mcp.includes('/') || mcp.includes('\\');
  if (named && !existsSync(mcp)) {
    console.error(`\nThe memory backend is not at ${mcp}.`);
    console.error('The build installs it from requirements.txt into /opt/venv,');
    console.error('and SIBYL_MCP_BIN must point at it.\n');
    process.exit(1);
  }
}

const kids = [];
let shuttingDown = false;

function start(name, args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = line => `[${name}] ${line}`;
  const pipe = stream => stream.on('data', d => {
    for (const line of d.toString().split('\n')) if (line.trim()) console.log(tag(line.trimEnd()));
  });
  pipe(child.stdout); pipe(child.stderr);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`\n[${name}] exited (${signal || code}). Bringing the container down so the host restarts it.\n`);
    stopAll(1);
  });
  kids.push(child);
  return child;
}

function stopAll(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of kids) { try { c.kill('SIGTERM'); } catch {} }
  setTimeout(() => {
    for (const c of kids) { try { c.kill('SIGKILL'); } catch {} }
    process.exit(code);
  }, 2000).unref();
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => stopAll(0));

console.log(`AIRTIGHT starting`);
console.log(`  network   ${process.env.X402_NETWORK || 'base-sepolia'}`);
console.log(`  price     ${process.env.X402_PRICE_USDC || '0.01'} USDC`);
console.log(`  seller    127.0.0.1:${SELLER_PORT} (internal)`);
console.log(`  settler   127.0.0.1:${FAC_PORT} (internal)`);
console.log(`  public    :${PUBLIC_PORT}\n`);

// The facilitator and seller must be listening before the public server offers
// anyone a button, so they go up first and get a moment to bind.
if (process.env.FACILITATOR_KEY) start('facilitator', ['facilitator/server.mjs']);
start('seller', ['seller/server.mjs', SELLER_PORT]);
await new Promise(r => setTimeout(r, 2500));
start('public', ['web/public-server.mjs'], { PORT: PUBLIC_PORT });
