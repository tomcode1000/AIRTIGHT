/**
 * A facilitator of our own.
 *
 * x402 is permissionless: the facilitator is a service that checks a signature
 * and then calls transferWithAuthorization, paying the gas. Nothing about the
 * protocol says it has to be someone else's. Running one removes the last
 * dependency on a third party, which matters when the hosted options are not
 * available to you, and it works on any chain the token is deployed to.
 *
 * It speaks the same three endpoints the seller already calls, so pointing at
 * it is one environment variable and no code change:
 *
 *   GET  /supported   which networks this will settle
 *   POST /verify      is this authorisation valid, and unused?
 *   POST /settle      submit it and return the transaction hash
 *
 * What it costs: the settler wallet pays gas. On Base that is a fraction of a
 * cent per settlement. The payer still pays no gas and still signs everything
 * themselves, exactly as with a hosted facilitator.
 *
 * Env:
 *   FACILITATOR_KEY      the settler's private key, used ONLY to pay gas
 *   FACILITATOR_PORT     default 4402
 *   X402_NETWORK         base | base-sepolia
 *   BASE_RPC_URL         optional override
 */
import http from 'node:http';
import { deriveAddress } from '../staging/x402/signer.mjs';
import { settleAuthorization, verifyAuthorization, nonceUsed, rpcClient } from '../x402/settle.mjs';

const PORT = Number(process.env.FACILITATOR_PORT || 4402);
const NETWORK = process.env.X402_NETWORK || 'base-sepolia';
const KEY = process.env.FACILITATOR_KEY || '';

const CHAIN = { base: 8453, 'base-sepolia': 84532 };
const RPC = {
  base: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
  'base-sepolia': process.env.BASE_RPC_URL || 'https://sepolia.base.org',
};
const TOKEN = {
  base: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', name: 'USD Coin', version: '2' },
  'base-sepolia': { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', name: 'USDC', version: '2' },
};

const chainId = CHAIN[NETWORK];
const token = TOKEN[NETWORK];
if (!chainId || !token) { console.error(`unknown network "${NETWORK}"`); process.exit(1); }
if (!/^0x[0-9a-fA-F]{64}$/.test(KEY)) {
  console.error('FACILITATOR_KEY must be set to a 0x-prefixed 64 hex character key.');
  console.error('This wallet pays gas only. Generate one with: node scripts/new-burner.mjs');
  process.exit(1);
}
const SETTLER = deriveAddress(KEY);
const call = rpcClient(RPC[NETWORK]);

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const readBody = req => new Promise(resolve => {
  let b = '';
  req.on('data', c => { b += c; if (b.length > 64_000) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  req.on('error', () => resolve({}));
});

/**
 * Pull the authorisation out of whichever envelope arrived.
 *
 * Two shapes are in circulation: the standard one nests the parts under
 * `payload`, and this repo's own stored record keeps them at the top level.
 * Accepting both costs four lines and avoids a settle-time failure that would
 * surface only after the agent had already signed.
 */
function extract(body) {
  const p = body.paymentPayload || body.payload || body;
  const inner = p.payload || p;
  const auth = inner.authorization || inner.auth;
  const signature = inner.signature;
  return { auth, signature, network: p.network || inner.network };
}

/** Does the authorisation actually pay what the seller asked for? */
function matchesRequirements(auth, req) {
  if (!req) return null;
  const want = String(req.payTo || req.pay_to || '').toLowerCase();
  if (want && String(auth.to).toLowerCase() !== want) {
    return `pays ${auth.to}, but this resource is paid to ${req.payTo || req.pay_to}`;
  }
  const min = req.maxAmountRequired ?? req.amount;
  if (min != null && BigInt(auth.value) < BigInt(min)) {
    return `pays ${auth.value}, which is less than the required ${min}`;
  }
  const asset = String(req.asset || '').toLowerCase();
  if (asset && asset !== token.address.toLowerCase()) {
    return `asset ${req.asset} is not the token this facilitator settles`;
  }
  return null;
}

async function check(body) {
  const { auth, signature } = extract(body);
  if (!auth || !signature) return { isValid: false, invalidReason: 'no authorisation in the request' };

  const v = verifyAuthorization({
    auth, signature, chainId, token: token.address,
    tokenName: token.name, tokenVersion: token.version,
  });
  if (!v.ok) return { isValid: false, invalidReason: v.reason };

  const mismatch = matchesRequirements(auth, body.paymentRequirements);
  if (mismatch) return { isValid: false, invalidReason: mismatch, payer: v.payer };

  // The contract is the authority on whether this nonce has been spent.
  try {
    if (await nonceUsed(call, { token: token.address, from: auth.from, nonce: auth.nonce })) {
      return { isValid: false, invalidReason: 'authorisation already used', payer: v.payer, alreadyUsed: true };
    }
  } catch (e) {
    // Not knowing is not the same as knowing it is unused. Refuse rather than
    // settle blind, because settling twice is the failure this project exists
    // to prevent.
    return { isValid: false, invalidReason: `cannot reach the chain to check the nonce: ${e.message}` };
  }
  return { isValid: true, payer: v.payer, auth, signature };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname.replace(/\/$/, '') || '/';

  if (p === '/supported') {
    return json(res, 200, { kinds: [{ x402Version: 1, scheme: 'exact', network: `eip155:${chainId}` },
                                    { x402Version: 1, scheme: 'exact', network: NETWORK }] });
  }
  if (p === '/health') return json(res, 200, { ok: true, network: NETWORK, settler: SETTLER });

  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  const body = await readBody(req);

  if (p === '/verify') {
    const r = await check(body);
    console.log(`verify  ${r.isValid ? 'ok' : 'REJECT ' + r.invalidReason}`);
    return json(res, 200, { isValid: r.isValid, invalidReason: r.invalidReason, payer: r.payer });
  }

  if (p === '/settle') {
    const r = await check(body);
    if (!r.isValid) {
      console.log(`settle  REJECT ${r.invalidReason}`);
      return json(res, 200, { success: false, network: NETWORK, errorReason: r.invalidReason, payer: r.payer });
    }
    console.log(`settle  submitting for ${r.payer}`);
    const out = await settleAuthorization({
      privateKey: KEY, rpcUrl: RPC[NETWORK], token: token.address, chainId,
      auth: r.auth, signature: r.signature,
    });
    console.log(`settle  ${out.success ? 'ok ' + out.transaction : 'FAILED ' + out.errorReason}`);
    return json(res, 200, { ...out, network: NETWORK, payer: r.payer });
  }

  json(res, 404, { error: 'not found' });
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') { console.error(`\nPort ${PORT} is already in use.\n`); process.exit(1); }
  throw e;
});

server.listen(PORT, async () => {
  console.log(`\nAIRTIGHT facilitator -> http://localhost:${PORT}`);
  console.log(`  network  ${NETWORK} (eip155:${chainId})`);
  console.log(`  token    ${token.address}`);
  console.log(`  settler  ${SETTLER}  (pays gas only)`);
  try {
    const wei = BigInt(await call('eth_getBalance', [SETTLER, 'latest']));
    const eth = Number(wei) / 1e18;
    console.log(`  gas      ${eth.toFixed(6)} ETH${eth === 0 ? '   <-- FUND THIS OR EVERY SETTLE FAILS' : ''}`);
  } catch (e) {
    console.log(`  gas      could not read balance: ${e.message}`);
  }
  console.log(`\n  point the seller at it:  X402_FACILITATOR_URL=http://localhost:${PORT}\n`);
});
