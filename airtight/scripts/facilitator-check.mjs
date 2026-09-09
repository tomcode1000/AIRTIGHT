/**
 * Is this configuration actually able to settle on the network it claims?
 *
 *   node scripts/facilitator-check.mjs                       # check what .env says
 *   node scripts/facilitator-check.mjs <url> [network]       # check a candidate
 *
 * x402 is permissionless, so the facilitator is swappable. The cost of that is
 * that a wrong one fails at settle time, after the agent has already signed,
 * which is the worst possible moment to find out. This checks the four things
 * that have to line up before any money is at risk:
 *
 *   1. the facilitator answers, and says which networks it settles
 *   2. it settles the network you configured, under scheme "exact"
 *   3. the USDC address you would sign against exists on that chain
 *   4. the EIP-712 domain you would sign matches the token's own name and
 *      version, read from the chain rather than trusted from a constant
 *
 * Nothing here signs or spends. It is safe to run against anything.
 */
const CHAIN = { base: 8453, 'base-sepolia': 84532 };
const RPC = {
  base: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
  'base-sepolia': process.env.BASE_RPC_URL || 'https://sepolia.base.org',
};
const USDC = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};
const EXPECT = {
  base: { name: 'USD Coin', version: '2' },
  'base-sepolia': { name: 'USDC', version: '2' },
};

const url = process.argv[2] || process.env.X402_FACILITATOR_URL || 'https://x402.org/facilitator';
const network = process.argv[3] || process.env.X402_NETWORK || 'base-sepolia';
const chainId = CHAIN[network];

let failed = false;
const ok = (s, d = '') => console.log(`  ok    ${s}${d ? '  ' + d : ''}`);
const no = (s, d = '') => { failed = true; console.log(`  FAIL  ${s}${d ? '  ' + d : ''}`); };

console.log(`\nfacilitator  ${url}`);
console.log(`network      ${network}${chainId ? ` (eip155:${chainId})` : ''}\n`);

if (!chainId) {
  no(`unknown network "${network}"`, 'expected base or base-sepolia');
  process.exit(1);
}

/* 1 + 2. does this facilitator settle this network? */
try {
  const r = await fetch(`${url.replace(/\/$/, '')}/supported`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) {
    // A 401 is a real answer: the facilitator is there and wants credentials.
    if (r.status === 401 || r.status === 403) {
      no(`facilitator needs credentials (HTTP ${r.status})`, 'set CDP_API_KEY_ID and CDP_API_KEY_SECRET');
    } else {
      no(`facilitator answered HTTP ${r.status}`);
    }
  } else {
    const body = await r.json();
    const kinds = body.kinds || [];
    const nets = [...new Set(kinds.map(k => k.network))];
    ok('facilitator reachable', `${kinds.length} kinds`);
    // Match the identifier exactly. A substring test looks harmless and is not:
    // "eip155:84532" contains "8453", so testnet would answer for mainnet and
    // this check would wave real money through to a facilitator that cannot
    // settle it. Accept the CAIP-2 form or the plain network name, nothing else.
    const accepted = new Set([`eip155:${chainId}`, network]);
    const exact = kinds.find(k => k.scheme === 'exact' && accepted.has(String(k.network)));
    if (exact) ok(`settles eip155:${chainId} with scheme "exact"`);
    else no(`does NOT settle eip155:${chainId}`, `it offers: ${nets.join(', ') || 'nothing'}`);
  }
} catch (e) {
  no('facilitator unreachable', e.message);
}

/* 3 + 4. would the signature we build actually be valid on this chain? */
const token = USDC[network];
async function callString(selector) {
  const r = await fetch(RPC[network], {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to: token, data: selector }, 'latest'] }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  if (!j.result || j.result === '0x') throw new Error('empty response, is there a contract at this address?');
  const hex = j.result.slice(2);
  const len = parseInt(hex.slice(64, 128), 16);
  return Buffer.from(hex.slice(128, 128 + len * 2), 'hex').toString('utf8');
}

try {
  const name = await callString('0x06fdde03');
  const version = await callString('0x54fd4d50');
  ok('USDC contract responds', token);
  const want = EXPECT[network];
  if (name === want.name && version === want.version) {
    ok('EIP-712 domain matches the chain', `name "${name}", version "${version}"`);
  } else {
    no('EIP-712 domain would be rejected',
       `chain says name "${name}" version "${version}", we sign "${want.name}"/"${want.version}"`);
  }
} catch (e) {
  no('could not read the USDC contract', e.message);
}

/* what else has to be set before a real run */
console.log('');
for (const [k, why] of [
  ['X402_PAY_TO', 'the seller wallet, or the challenge is unusable'],
  ['DEMO_BUYER_KEY', 'the buyer cannot sign without it'],
]) {
  if (process.env[k]) ok(`${k} is set`);
  else no(`${k} is not set`, why);
}
if (network === 'base' && !(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET)
    && /cdp\.coinbase\.com/.test(url)) {
  no('CDP credentials missing', 'this facilitator will refuse every settle');
}

console.log(failed
  ? '\nNOT READY. Fix the failures above before pointing real money at it.\n'
  : '\nREADY. This configuration can settle on ' + network + '.\n');
process.exit(failed ? 1 : 0);
