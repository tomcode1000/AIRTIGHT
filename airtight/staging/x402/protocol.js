// ─────────────────────────────────────────────────────────────────────────────
// x402: pay-per-call via the x402 protocol (HTTP 402 + USDC on Base).
// NO Stripe. Phase 4 directive.
//
// Flow:
//   1. Client calls resource without X-PAYMENT → server returns 402 with
//      `accepts` payment requirements (scheme "exact", network base/base-sepolia).
//   2. Client builds an EIP-3009 transferWithAuthorization signature and retries
//      with `X-PAYMENT: base64({x402Version, scheme, network, payload})`.
//   3. Server verifies via FACILITATOR (/verify): the facilitator does all
//      on-chain/crypto checks, we stay zero-dep.
//   4. Service runs; facilitator /settle moves the USDC; response carries
//      X-PAYMENT-RESPONSE with the settlement receipt.
//
// REPLAY GUARD (Aug-22): consumed signatures tracked server-side
// (`paymentAlreadyUsed/markPaymentUsed/forgetPayment` in x402.js). Nonce burned
// synchronously when a verified payment is accepted for execution → duplicate
// header gets 402 "payment replay detected". Nonce RELEASED on non-runnable
// requests (400/422) so an agent can retry the SAME paid header with corrected
// params (live-verified: clarify → fix county → same header settles once).
// In-memory only: restart clears it; the EIP-3009 on-chain nonce remains the
// backstop against double-settlement.
//
// PAYMENT POLICY: IMPLEMENTED Aug-22 (was open):
// - Auto-retry: paid runs re-execute up to JOB_MAX_ATTEMPTS (default 2) before
//   terminal failure (`job.attempts` persisted; history shows each attempt).
// - Refund lane: terminal failure of a PAID job auto-credits the full price
//   (X402_PRICE_USDC) to the payer address in a persisted service-credit ledger
//   (`src/payment/credits.js`, CREDITS_FILE, default data/credits.json). No
//   payout wallet needed: value stays as spendable credit.
// - Credit spend: when the gate would 402, spendable credit ≥ price pays for the
//   request outright (payment_ref becomes `credit:<payer>`); exhausted → normal
//   payment challenge. Live-tested + unit-tested (test/credits.test.js).
// - Admin view: GET /v1/admin/credits[?payer=0x…] (Bearer ADMIN_TOKEN).
//
// DISCOVERY MANIFEST (Aug-22): GET /v1/schema = machine-readable capability doc
// for agents/marketplaces (lanes, endpoints, x402 flow steps, error codes,
// limits) built from live config so it can't drift. Same doc also served at
// /.well-known/ai-plugin.json and /.well-known/x402-service.json. Verified live.
//
// STILL OPEN PRE-LISTING:
// - X402_PAY_TO unset → challenge ships payTo:"" (unusable by buyers).
// - Replay map is in-memory (restart clears; on-chain EIP-3009 nonce backstops).
//
// PAYMENT_MODE=x402-mock skips the facilitator for dev/tests (auto-valid).
// ─────────────────────────────────────────────────────────────────────────────

const USDC_ADDRESSES = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

// EIP-712 domain per network: MUST match the token contract's on-chain
// name()/version() or the free facilitator rejects verify
// (invalid_exact_evm_token_name_mismatch / invalid_exact_evm_signature).
// base-sepolia verified live Aug-23 via eth_call: name()="USDC", version()="2".
// base mainnet native USDC is "USD Coin"/"2": re-verify via eth_call before flip.
const USDC_TOKEN_META = {
  base: { name: 'USD Coin', version: '2' },
  'base-sepolia': { name: 'USDC', version: '2' },
};

export function x402Config() {
  const network = process.env.X402_NETWORK || 'base-sepolia';
  const priceUsdc = Number(process.env.X402_PRICE_USDC || 25);
  return {
    network,
    payTo: process.env.X402_PAY_TO || '',
    priceUsdc,
    maxAmountRequired: String(Math.round(priceUsdc * 1_000_000)), // USDC = 6 decimals
    asset: USDC_ADDRESSES[network] || USDC_ADDRESSES['base-sepolia'],
    tokenMeta: USDC_TOKEN_META[network] || USDC_TOKEN_META['base-sepolia'],
    facilitatorUrl:
      process.env.X402_FACILITATOR_URL ||
      'https://api.cdp.coinbase.com/platform/v2/x402',
    cdpKeyId: process.env.CDP_API_KEY_ID || '',
    cdpKeySecret: process.env.CDP_API_KEY_SECRET || '',
    mock: process.env.PAYMENT_MODE === 'x402-mock',
  };
}

/** Build the 402 challenge body. */
export function buildPaymentRequirements(resourceUrl, description = 'Acquisition signal report run') {
  const cfg = x402Config();
  return {
    x402Version: 1,
    error: 'X-PAYMENT header is required',
    demo: cfg.mock, // true = mock mode (client-side fake sig OK); false/absent = REAL facilitator verify/settle
    accepts: [
      {
        scheme: 'exact',
        network: cfg.network,
        maxAmountRequired: cfg.maxAmountRequired,
        resource: resourceUrl,
        description,
        mimeType: 'application/json',
        payTo: cfg.payTo,
        maxTimeoutSeconds: 600,
        asset: cfg.asset,
        extra: cfg.tokenMeta,
      },
    ],
    facilitator: { requestUrl: cfg.facilitatorUrl },
  };
}

/** Decode + sanity-check the X-PAYMENT header. Returns null when malformed. */
export function decodePaymentHeader(headerValue) {
  try {
    const decoded = JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8'));
    if (!decoded || decoded.scheme !== 'exact' || !decoded.payload) return null;
    if (!decoded.payload.authorization || !decoded.payload.signature) return null;
    return decoded;
  } catch {
    return null;
  }
}

function facilitatorHeaders(cfg) {
  const h = { 'Content-Type': 'application/json' };
  if (cfg.cdpKeyId && cfg.cdpKeySecret) {
    h.Authorization = `Basic ${Buffer.from(`${cfg.cdpKeyId}:${cfg.cdpKeySecret}`).toString('base64')}`;
  }
  return h;
}

async function facilitatorCall(cfg, action, paymentHeader, requirements) {
  // Two facilitator dialects: CDP's platform API takes the raw base64 header;
  // open facilitators (x402.org etc.) take the DECODED payload object.
  const isCdp = /api\.cdp\.coinbase\.com/.test(cfg.facilitatorUrl);
  let body;
  if (isCdp) {
    body = { x402Version: 1, paymentHeader, paymentRequirements: requirements.accepts[0] };
  } else {
    const decoded = decodePaymentHeader(paymentHeader);
    body = { x402Version: 1, paymentPayload: decoded ? { ...decoded } : {}, paymentRequirements: requirements.accepts[0] };
  }
  const res = await fetch(`${cfg.facilitatorUrl}/${action}`, {
    method: 'POST',
    headers: facilitatorHeaders(cfg),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`facilitator ${action} HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Verify a payment header against the requirements.
 * @returns {Promise<{isValid:boolean, invalidReason?:string, payer?:string}>}
 */
export async function verifyPayment(paymentHeader, requirements) {
  const cfg = x402Config();
  if (cfg.mock) {
    const decoded = decodePaymentHeader(paymentHeader);
    if (!decoded) return { isValid: false, invalidReason: 'malformed X-PAYMENT header' };
    return { isValid: true, payer: decoded.payload?.authorization?.from || 'mock-payer' };
  }
  const out = await facilitatorCall(cfg, 'verify', paymentHeader, requirements);
  return { isValid: Boolean(out.isValid), invalidReason: out.invalidReason, payer: out.payer };
}

/**
 * Settle after service delivery commitment. Returns the receipt object that
 * goes into the X-PAYMENT-RESPONSE header (base64 JSON per spec).
 */
export async function settlePayment(paymentHeader, requirements) {
  const cfg = x402Config();
  let receipt;
  if (cfg.mock) {
    const decoded = decodePaymentHeader(paymentHeader);
    const payer = decoded?.payload?.authorization?.from || 'mock-payer';
    receipt = { success: true, network: cfg.network, transaction: '0x_mock_settlement', payer };
  } else {
    receipt = await facilitatorCall(cfg, 'settle', paymentHeader, requirements);
  }
  return {
    receipt,
    headerValue: Buffer.from(JSON.stringify(receipt)).toString('base64'),
  };
}

// ── replay protection (server-side, in-memory) ──────────────────────────────
// The EIP-3009 nonce is enforced ON-CHAIN by the facilitator at settle time,
// but nothing stopped this server from QUEUEING a second job off a replayed
// Track consumed signatures here: marked
// synchronously the moment a verified payment is accepted for execution,
// released again if the request turns out non-runnable (400/422) so an agent
// can retry the SAME paid header with corrected params. In-memory only: a
// restart clears it; the on-chain nonce remains the real backstop against
// double-settlement.
const usedPayments = new Map(); // fingerprint → { payer, at }

function paymentFingerprint(headerValue) {
  const decoded = decodePaymentHeader(headerValue);
  if (!decoded) return null;
  return Buffer.from(
    JSON.stringify([decoded.payload.signature, decoded.payload.authorization])
  ).toString('base64url');
}

/** True when this exact X-PAYMENT was already accepted for execution. */
export function paymentAlreadyUsed(headerValue) {
  const fp = paymentFingerprint(headerValue);
  return Boolean(fp && usedPayments.has(fp));
}

export function markPaymentUsed(headerValue, payer = '') {
  const fp = paymentFingerprint(headerValue);
  if (fp) usedPayments.set(fp, { payer, at: new Date().toISOString() });
}

/** Release a nonce (non-runnable request) so the header stays spendable. */
export function forgetPayment(headerValue) {
  const fp = paymentFingerprint(headerValue);
  if (fp) usedPayments.delete(fp);
}
