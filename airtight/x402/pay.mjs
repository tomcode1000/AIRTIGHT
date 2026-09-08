/**
 * x402 buyer leg. Sign once, store, re-submit the stored authorisation.
 *
 * ── Why this file is where memory becomes load-bearing ──────────────────────
 * `signTransferWithAuthorization` mints a RANDOM EIP-3009 nonce on every call.
 * That nonce is the only thing making a payment idempotent: the token contract
 * honours a given (from, nonce) exactly once, so re-submitting the SAME signed
 * authorisation can never move funds twice, while signing a FRESH one after a
 * crash pays the seller a second time.
 *
 * So the authorisation must be durably recorded BEFORE it is submitted, and a
 * woken agent must re-submit what it stored rather than sign anew. Without a
 * memory layer there is nothing to re-submit, and the only crash-safe options
 * are to double-pay or to never retry. This is x402 issue #452 in one function.
 */
import crypto from 'node:crypto';
import { signTransferWithAuthorization, deriveAddress } from '../staging/x402/signer.mjs';

export const CHAIN_IDS = { base: 8453, 'base-sepolia': 84532 };

/** sha256(resource|nonce|amount|payTo): same shape as deals.paymentFingerprint. */
export function fingerprintFor({ resource, nonce, amount, payTo }) {
  return crypto.createHash('sha256')
    .update(Buffer.from([resource, nonce, amount, payTo].map(String).join('|'), 'utf8'))
    .digest('hex');
}

/** Encode the wire header from an authorisation + signature. */
export function encodeHeader({ authorization, signature, network }) {
  const wire = { x402Version: 1, scheme: 'exact', network, payload: { authorization, signature } };
  return Buffer.from(JSON.stringify(wire), 'utf8').toString('base64');
}

/**
 * Sign a fresh authorisation for a 402 challenge.
 *
 * Returns everything needed to (a) submit now and (b) submit the identical
 * payment again later. Persist the whole `stored` object before submitting.
 */
export function signPayment({ privateKey, requirements, ttlSeconds = 600 }) {
  const accept = requirements?.accepts?.[0];
  if (!accept) throw new Error('signPayment: challenge has no accepts[0]');
  if (accept.scheme !== 'exact') throw new Error(`signPayment: unsupported scheme ${accept.scheme}`);
  if (!accept.payTo) throw new Error('signPayment: challenge has empty payTo: X402_PAY_TO unset on the seller');

  const chainId = CHAIN_IDS[accept.network];
  if (!chainId) throw new Error(`signPayment: unknown network ${accept.network}`);

  const from = deriveAddress(privateKey);
  const valueUsdc = Number(accept.maxAmountRequired) / 1e6;

  const signed = signTransferWithAuthorization({
    privateKey, from, to: accept.payTo, valueUsdc, chainId,
    verifyingContract: accept.asset,
    ttlSeconds,
    // MUST match the token contract's on-chain name()/version() or the
    // facilitator rejects with invalid_exact_evm_token_name_mismatch.
    tokenName: accept.extra?.name ?? 'USDC',
    tokenVersion: accept.extra?.version ?? '2',
  });

  const stored = {
    network: accept.network,
    resource: accept.resource,
    pay_to: accept.payTo,
    asset: accept.asset,
    amount: accept.maxAmountRequired,
    authorization: signed.authorization,
    signature: signed.signature,
  };
  return {
    stored,
    payer: from,
    header: encodeHeader(stored),
    fingerprint: fingerprintFor({
      resource: accept.resource, nonce: signed.authorization.nonce,
      amount: accept.maxAmountRequired, payTo: accept.payTo,
    }),
  };
}

/**
 * Rebuild the wire header from what memory recorded. This is the resume path:
 * byte-identical to the original submission, so the on-chain nonce guarantees
 * at-most-once settlement no matter how many times we are killed and woken.
 */
export function headerFromStored(stored) {
  if (!stored?.authorization || !stored?.signature) {
    throw new Error('headerFromStored: stored payment is incomplete: refusing to re-sign');
  }
  return encodeHeader(stored);
}

export function fingerprintOfStored(stored) {
  return fingerprintFor({
    resource: stored.resource, nonce: stored.authorization.nonce,
    amount: stored.amount, payTo: stored.pay_to,
  });
}

/** GET a resource, expecting either 200 or a 402 challenge. */
export async function fetchChallenge(url, { timeoutMs = 30000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 402) return { status: 402, challenge: await res.json() };
  return { status: res.status, body: await res.text() };
}

/** Submit a payment header and collect the payload + settlement receipt. */
export async function submitPayment(url, header, { timeoutMs = 60000 } = {}) {
  const res = await fetch(url, {
    headers: { 'X-PAYMENT': header },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  const receiptHeader = res.headers.get('x-payment-response');
  const attHeader = res.headers.get('x-airtight-attestation');
  let attestation = null;
  if (attHeader) {
    try { attestation = JSON.parse(Buffer.from(attHeader, 'base64').toString('utf8')); } catch {}
  }
  let receipt = null;
  if (receiptHeader) {
    try { receipt = JSON.parse(Buffer.from(receiptHeader, 'base64').toString('utf8')); } catch {}
  }
  return { status: res.status, body: text, receipt, attestation };
}

export default { signPayment, headerFromStored, fingerprintFor, fingerprintOfStored, fetchChallenge, submitPayment, encodeHeader, CHAIN_IDS };
