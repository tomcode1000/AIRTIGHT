// ─────────────────────────────────────────────────────────────────────────────
// payment gate: DECOUPLED from the pipeline (brief §4.7): a gate in the
// orchestrator, never woven into data logic.
//
// Modes (env PAYMENT_MODE):
//   stub: auto-approve everything (dev/testing)
//   manual: request stays needs_payment until an admin confirms via endpoint
//            (v1 "Stripe link / off-platform" flow)
//   x402 | escrow: reserved hooks for Phase 4; currently behave like manual.
//
// Standing clients (env STANDING_REQUESTERS, comma-separated ids) bypass the
// gate in every mode: Larry is already a paying subscriber.
// ─────────────────────────────────────────────────────────────────────────────

const STANDING = new Set(
  (process.env.STANDING_REQUESTERS || 'larry')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

export function isStandingClient(requesterId) {
  return STANDING.has(String(requesterId || '').toLowerCase());
}

export function createPaymentGate(mode = process.env.PAYMENT_MODE || 'stub') {
  /** @returns {{status:'approved'|'pending', reason?:string}} */
  async function evaluate({ requesterId, paymentRef }) {
    if (isStandingClient(requesterId)) {
      return { status: 'approved', reason: 'standing_client' };
    }
    switch (mode) {
      case 'stub':
        return { status: 'approved', reason: 'stub_mode' };
      case 'manual':
      case 'x402':
      case 'escrow':
        return {
          status: 'pending',
          reason:
            mode === 'manual'
              ? 'awaiting manual payment confirmation'
              : `${mode} integration pending Phase 4`,
        };
      default:
        throw new Error(`Unknown PAYMENT_MODE "${mode}"`);
    }
  }

  /** Confirm a pending payment (admin/manual flow). */
  function confirm(job) {
    // In manual mode confirmation simply flips the job forward: the
    // orchestrator re-enqueues on this signal. Kept trivially sync on purpose.
    return true;
  }

  return { mode, evaluate, confirm };
}
