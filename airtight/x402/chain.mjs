/**
 * Reading the chain back.
 *
 * ── When this is needed, and when it is not ─────────────────────────────────
 * Resuming from IN_FLIGHT does NOT need it. The agent may have died before the
 * facilitator answered, in which case there is no transaction hash to look up,
 * asking "did my payment land" is unanswerable from the outside. Re-submitting
 * the stored authorisation is both simpler and safer: the nonce is either burned
 * already (nothing moves) or it is not (it settles once).
 *
 * Once a tx_hash HAS been recorded, that reasoning stops applying. The hash came
 * from a facilitator's response, and a response can be wrong, a chain can
 * reorganise, and a record can be tampered with. `assessDeal` already refuses to
 * act on a payment it cannot confirm; this is what lets it actually check.
 *
 * Failure to reach an RPC is NOT evidence of anything. It returns null, which
 * assessDeal treats as "not checked", so a flaky network cannot manufacture a
 * refusal. Only a definite "no such transaction" does that.
 */

export const DEFAULT_RPC = { 'base-sepolia': 'https://sepolia.base.org', base: 'https://mainnet.base.org' };

/** Real 32-byte hashes only: mock settlements carry placeholders. */
export const isTxHash = h => /^0x[0-9a-fA-F]{64}$/.test(String(h ?? ''));

export function rpcFor(network) {
  return process.env.BASE_RPC_URL || DEFAULT_RPC[network] || DEFAULT_RPC['base-sepolia'];
}

/**
 * Does this transaction exist and succeed on chain?
 *
 * @returns true: mined and successful
 *          false: the chain answered, and there is no such successful tx
 *          null: could not check (no real hash, unreachable RPC, timeout)
 */
export async function txFound(hash, { network = 'base-sepolia', timeoutMs = 8000 } = {}) {
  if (!isTxHash(hash)) return null;                 // nothing to verify
  try {
    const res = await fetch(rpcFor(network), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const { result, error } = await res.json();
    if (error) return null;
    if (result == null) return false;               // the chain has never seen it
    return result.status === '0x1';                 // mined, and it succeeded
  } catch {
    return null;                                    // unreachable ≠ unpaid
  }
}

export default { txFound, isTxHash, rpcFor, DEFAULT_RPC };
