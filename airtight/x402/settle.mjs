/**
 * Settle an EIP-3009 authorisation ourselves, with no third-party facilitator.
 *
 * A facilitator is a convenience, not a requirement: all it does is check a
 * signature and then call transferWithAuthorization on the token contract,
 * paying the gas. This does the same thing, which means mainnet settlement
 * needs nobody's permission and nobody's API key. The only cost is that the
 * wallet submitting the transaction has to hold a little ETH for gas.
 *
 * The payer still spends no gas and still signs nothing here. Their signed
 * authorisation is carried in the call data, exactly as a facilitator would
 * carry it, so the nonce is still what makes the payment unrepeatable.
 *
 * Everything is built from the primitives already in this repo. There is no
 * dependency, and no library is trusted with a key.
 */
import { keccak256, signDigest, recoverAddress, deriveAddress } from '../staging/x402/signer.mjs';

/* ── RLP ───────────────────────────────────────────────────────────────
   Ethereum's encoding. Two rules: a byte string is length-prefixed unless it
   is a single byte below 0x80, and a list is length-prefixed over the
   concatenation of its encoded items. Integers are minimal big-endian, and
   zero is the empty string, not a zero byte. That last detail is the classic
   way a hand-rolled encoder produces a transaction the network rejects. */
function rlpLen(len, offset) {
  if (len < 56) return Buffer.from([offset + len]);
  const hex = len.toString(16);
  const lenBytes = Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex');
  return Buffer.concat([Buffer.from([offset + 55 + lenBytes.length]), lenBytes]);
}
export function rlp(input) {
  if (Array.isArray(input)) {
    const body = Buffer.concat(input.map(rlp));
    return Buffer.concat([rlpLen(body.length, 0xc0), body]);
  }
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length === 1 && buf[0] < 0x80) return buf;
  return Buffer.concat([rlpLen(buf.length, 0x80), buf]);
}
/** Minimal big-endian bytes. Zero is empty, which RLP requires. */
export function num(n) {
  let hex = BigInt(n).toString(16);
  if (hex === '0') return Buffer.alloc(0);
  if (hex.length % 2) hex = '0' + hex;
  return Buffer.from(hex, 'hex');
}
const bytes = h => Buffer.from(String(h).replace(/^0x/, ''), 'hex');

/* ── ABI ───────────────────────────────────────────────────────────────── */
const selector = sig => keccak256(sig).subarray(0, 4);
const word = v => {
  if (typeof v === 'string' && v.startsWith('0x')) {
    const b = bytes(v);
    return Buffer.concat([Buffer.alloc(32 - b.length), b]);
  }
  const b = num(v);
  return Buffer.concat([Buffer.alloc(32 - b.length), b]);
};

const TRANSFER_SEL = selector(
  'transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)');
const STATE_SEL = selector('authorizationState(address,bytes32)');

/* ── EIP-712, recomputed so we can check a signature without trusting it ─── */
const DOMAIN_TYPEHASH = keccak256(
  'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)');
const TRANSFER_TYPEHASH = keccak256(
  'TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)');

export function authDigest({ auth, chainId, token, tokenName, tokenVersion }) {
  const domain = keccak256(Buffer.concat([
    word('0x' + DOMAIN_TYPEHASH.toString('hex')),
    word('0x' + keccak256(tokenName).toString('hex')),
    word('0x' + keccak256(tokenVersion).toString('hex')),
    word(chainId),
    word(token.toLowerCase()),
  ]));
  const struct = keccak256(Buffer.concat([
    word('0x' + TRANSFER_TYPEHASH.toString('hex')),
    word(auth.from.toLowerCase()),
    word(auth.to.toLowerCase()),
    word(auth.value),
    word(auth.validAfter),
    word(auth.validBefore),
    word(auth.nonce),
  ]));
  return keccak256(Buffer.concat([Buffer.from([0x19, 0x01]), domain, struct]));
}

/** Split the 65 byte wire signature back into its parts. */
export function splitSig(sig) {
  const b = bytes(sig);
  if (b.length !== 65) throw new Error(`signature must be 65 bytes, got ${b.length}`);
  let v = b[64];
  if (v < 27) v += 27;                 // some signers emit 0/1
  return { r: BigInt('0x' + b.subarray(0, 32).toString('hex')),
           s: BigInt('0x' + b.subarray(32, 64).toString('hex')), v };
}

/* ── JSON-RPC ──────────────────────────────────────────────────────────── */
export function rpcClient(url) {
  let id = 0;
  return async function call(method, params = []) {
    const r = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  };
}

/**
 * Has this authorisation already been used?
 *
 * This is the check that makes replay impossible, and it is asked of the token
 * contract rather than of any record we keep, because the contract is the only
 * thing that actually decides. A true here means a second settle would revert.
 */
export async function nonceUsed(call, { token, from, nonce }) {
  const data = '0x' + Buffer.concat([STATE_SEL, word(from.toLowerCase()), word(nonce)]).toString('hex');
  const res = await call('eth_call', [{ to: token, data }, 'latest']);
  return BigInt(res || '0x0') !== 0n;
}

/** Recover the signer and check it against the stated payer. */
export function verifyAuthorization({ auth, signature, chainId, token, tokenName, tokenVersion }) {
  const digest = authDigest({ auth, chainId, token, tokenName, tokenVersion });
  const signer = recoverAddress(digest, splitSig(signature));
  if (!signer) return { ok: false, reason: 'signature does not recover' };
  if (signer.toLowerCase() !== String(auth.from).toLowerCase()) {
    return { ok: false, reason: `signed by ${signer}, not by the stated payer` };
  }
  const now = Math.floor(Date.now() / 1000);
  if (Number(auth.validBefore) <= now) return { ok: false, reason: 'authorisation has expired' };
  if (Number(auth.validAfter) > now)  return { ok: false, reason: 'authorisation is not valid yet' };
  return { ok: true, payer: signer };
}

/* ── sign and broadcast an EIP-1559 transaction ────────────────────────── */
async function signedTx({ privateKey, chainId, nonce, maxPriority, maxFee, gas, to, data }) {
  const fields = [
    num(chainId), num(nonce), num(maxPriority), num(maxFee), num(gas),
    bytes(to), num(0), bytes(data), [],
  ];
  const digest = keccak256(Buffer.concat([Buffer.from([0x02]), rlp(fields)]));
  const { r, s, v } = signDigest(privateKey, digest);
  const signed = [...fields, num(v - 27), num(r), num(s)];
  return '0x02' + rlp(signed).toString('hex');
}

/**
 * Submit the payer's authorisation to the token contract and wait for it.
 *
 * `privateKey` here is the settler's, and it is used only to pay gas: it never
 * touches the payer's funds, because the transfer is authorised by the payer's
 * own signature carried in the call data.
 */
export async function settleAuthorization({
  privateKey, rpcUrl, token, chainId, auth, signature, confirmations = 1, timeoutMs = 90_000,
}) {
  const call = rpcClient(rpcUrl);
  const settler = deriveAddress(privateKey);
  const { r, s, v } = splitSig(signature);

  const data = '0x' + Buffer.concat([
    TRANSFER_SEL,
    word(auth.from.toLowerCase()), word(auth.to.toLowerCase()), word(auth.value),
    word(auth.validAfter), word(auth.validBefore), word(auth.nonce),
    word(v), word('0x' + r.toString(16).padStart(64, '0')), word('0x' + s.toString(16).padStart(64, '0')),
  ]).toString('hex');

  // Estimating first turns a would-be revert into an error before any gas is
  // spent, and a revert here usually means the nonce is already used.
  let gas;
  try {
    gas = BigInt(await call('eth_estimateGas', [{ from: settler, to: token, data }]));
    gas = gas + gas / 5n;                       // 20% headroom
  } catch (e) {
    return { success: false, errorReason: `would revert: ${e.message}` };
  }

  const [txNonce, block, tip] = await Promise.all([
    call('eth_getTransactionCount', [settler, 'pending']),
    call('eth_getBlockByNumber', ['latest', false]),
    call('eth_maxPriorityFeePerGas', []).catch(() => '0x3b9aca00'),   // 1 gwei if unsupported
  ]);
  const base = BigInt(block.baseFeePerGas || '0x0');
  const maxPriority = BigInt(tip);
  const maxFee = base * 2n + maxPriority;

  const raw = await signedTx({
    privateKey, chainId, nonce: BigInt(txNonce), maxPriority, maxFee, gas, to: token, data,
  });

  let hash;
  try { hash = await call('eth_sendRawTransaction', [raw]); }
  catch (e) { return { success: false, errorReason: `broadcast rejected: ${e.message}` }; }

  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const receipt = await call('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (receipt) {
      if (receipt.status !== '0x1') return { success: false, transaction: hash, errorReason: 'transaction reverted' };
      if (confirmations <= 1) return { success: true, transaction: hash, settler };
      const head = BigInt(await call('eth_blockNumber', []));
      if (head - BigInt(receipt.blockNumber) + 1n >= BigInt(confirmations)) {
        return { success: true, transaction: hash, settler };
      }
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  // Broadcast but unconfirmed is not the same as failed, and must not be
  // reported as one: the money may well move a second later.
  return { success: false, transaction: hash, pending: true, errorReason: 'not confirmed within the timeout' };
}

export default { settleAuthorization, verifyAuthorization, nonceUsed, authDigest, rpcClient };
