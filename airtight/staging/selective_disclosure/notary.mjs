/**
 * AIRTIGHT — notarization of agent work (prompt / result / delivered content).
 *
 * Binds a piece of work to the deal that paid for it, signed by the SAME key
 * that pays. An adjudicator can therefore tie an attestation to the on-chain
 * payer address without trusting either agent's word.
 *
 * ── The security property that matters ───────────────────────────────────────
 * Attestations are signed under a domain separator that is DISJOINT from USDC's
 * EIP-3009 domain (different name, version, and verifyingContract). An
 * attestation signature can therefore never be replayed as a
 * TransferWithAuthorization, and a transfer authorization can never be passed
 * off as an attestation. Signing arbitrary agent output with the payment key
 * under the payment domain would be a wallet-draining bug; this file exists to
 * make that impossible by construction.
 *
 * Hard line (SCHEMA.md): the private key comes from env and is never written to
 * Sibyl Memory. Nothing this module returns contains key material.
 */
import crypto from 'node:crypto';
import {
  keccak256, signDigest, deriveAddress, recoverAddress
} from '../x402/signer.mjs';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

// Deliberately unlike USDC's ("USD Coin"/"2"/<token address>). Any one of these
// differing is sufficient for disjointness; all three differ.
export const NOTARY_DOMAIN = { name: 'AIRTIGHT Notary', version: '1', verifyingContract: ZERO_ADDR };

const DOMAIN_TYPEHASH = keccak256('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)');
const ATTESTATION_TYPEHASH = keccak256(
  'DealAttestation(bytes32 dealId,string role,string kind,bytes32 termsHash,bytes32 merkleRoot,bytes32 payloadHash,uint256 issuedAt)'
);

export const KINDS = Object.freeze(['prompt', 'result', 'delivery']);

const pad32 = v => {
  if (typeof v === 'bigint' || typeof v === 'number') return BigInt(v).toString(16).padStart(64, '0');
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).toString('hex').padStart(64, '0');
  const h = String(v).toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]*$/.test(h)) throw new Error('pad32: non-hex input');
  if (h.length > 64) throw new Error('pad32: value wider than 32 bytes');
  return h.padStart(64, '0');
};
const bytes32 = (label, v) => {
  const h = String(v ?? '').toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`${label} must be 32 bytes of hex, got: ${String(v).slice(0, 20)}`);
  return h;
};

/** sha256 of the exact bytes delivered. Content itself is never signed directly. */
export function payloadHash(bytesOrString) {
  const buf = Buffer.isBuffer(bytesOrString) ? bytesOrString : Buffer.from(String(bytesOrString), 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Stable bytes32 handle for a human-readable deal id like `dt-1693720000-ab12`. */
export function dealIdHash(dealId) {
  return crypto.createHash('sha256').update(Buffer.from(String(dealId), 'utf8')).digest('hex');
}

function attestationDigest({ dealId, role, kind, termsHash, merkleRoot, payloadHash: ph, issuedAt, chainId }) {
  const domainSep = keccak256(Buffer.concat([
    Buffer.from(pad32(DOMAIN_TYPEHASH), 'hex'),
    Buffer.from(pad32(keccak256(NOTARY_DOMAIN.name)), 'hex'),
    Buffer.from(pad32(keccak256(NOTARY_DOMAIN.version)), 'hex'),
    Buffer.from(pad32(BigInt(chainId)), 'hex'),
    Buffer.from(pad32(NOTARY_DOMAIN.verifyingContract), 'hex'),
  ]));
  const structHash = keccak256(Buffer.concat([
    Buffer.from(pad32(ATTESTATION_TYPEHASH), 'hex'),
    Buffer.from(pad32(dealIdHash(dealId)), 'hex'),
    Buffer.from(pad32(keccak256(role)), 'hex'),          // dynamic string → hashed
    Buffer.from(pad32(keccak256(kind)), 'hex'),
    Buffer.from(pad32(bytes32('termsHash', termsHash)), 'hex'),
    Buffer.from(pad32(bytes32('merkleRoot', merkleRoot)), 'hex'),
    Buffer.from(pad32(bytes32('payloadHash', ph)), 'hex'),
    Buffer.from(pad32(BigInt(issuedAt)), 'hex'),
  ]));
  return keccak256(Buffer.concat([Buffer.from([0x19, 0x01]), domainSep, structHash]));
}

/**
 * Notarize one artifact of a deal.
 *
 * @param privateKey  0x-prefixed, from env. NEVER from Sibyl Memory.
 * @param merkleRoot  root from buildCommitment() — ties the attestation to the
 *                    selectively-disclosable record without revealing it.
 * @returns an attestation record safe to store in Sibyl Memory and to hand to a
 *          counterparty. Contains no key material and no plaintext payload.
 */
export function notarize({ privateKey, dealId, role, kind, termsHash, merkleRoot, payloadHash: ph, chainId, issuedAt }) {
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error('notarize: privateKey must be 0x + 64 hex chars (env-sourced)');
  }
  if (!KINDS.includes(kind)) throw new Error(`notarize: kind must be one of ${KINDS.join('|')}`);
  if (role !== 'buyer' && role !== 'seller') throw new Error('notarize: role must be buyer|seller');
  if (!Number.isInteger(Number(chainId)) || Number(chainId) <= 0) throw new Error('notarize: chainId required');

  const at = Number.isInteger(issuedAt) ? issuedAt : Math.floor(Date.now() / 1000);
  const fields = {
    dealId, role, kind,
    termsHash: bytes32('termsHash', termsHash),
    merkleRoot: bytes32('merkleRoot', merkleRoot),
    payloadHash: bytes32('payloadHash', ph),
    issuedAt: at,
    chainId: Number(chainId),
  };
  const digest = attestationDigest(fields);
  const { r, s, v } = signDigest(privateKey, digest);
  const signature = '0x' + r.toString(16).padStart(64, '0') + s.toString(16).padStart(64, '0') + v.toString(16).padStart(2, '0');
  const signer = deriveAddress(privateKey);

  // Fail closed: never emit an attestation we cannot ourselves verify.
  const recovered = recoverAddress(digest, { r, s, v });
  if (recovered !== signer) throw new Error('notarize: self-verification failed, refusing to emit');

  return { v: 1, ...fields, signer, signature, digest: '0x' + Buffer.from(digest).toString('hex') };
}

/**
 * Verify an attestation. Returns { ok, signer, reason }.
 *
 * @param expect optional bindings the caller already trusts — typically
 *               { signer, termsHash, merkleRoot, payloadHash, dealId }. Checking
 *               these is what turns "a valid signature by someone" into "the
 *               payer attested to THIS payload for THIS deal".
 */
export function verifyAttestation(att, expect = {}) {
  try {
    if (att?.v !== 1) return { ok: false, reason: 'unsupported attestation version' };
    if (!KINDS.includes(att.kind)) return { ok: false, reason: 'unknown kind' };
    const m = /^0x([0-9a-fA-F]{64})([0-9a-fA-F]{64})([0-9a-fA-F]{2})$/.exec(att.signature || '');
    if (!m) return { ok: false, reason: 'malformed signature' };

    const digest = attestationDigest(att);
    if (att.digest && att.digest.toLowerCase() !== '0x' + Buffer.from(digest).toString('hex')) {
      return { ok: false, reason: 'digest does not match attested fields' };
    }
    const recovered = recoverAddress(digest, {
      r: '0x' + m[1], s: '0x' + m[2], v: parseInt(m[3], 16),
    });
    if (!recovered) return { ok: false, reason: 'signature does not recover' };
    if (recovered.toLowerCase() !== String(att.signer).toLowerCase()) {
      return { ok: false, reason: 'signature was not made by the claimed signer' };
    }
    for (const [k, want] of Object.entries(expect)) {
      if (want == null) continue;
      const got = att[k];
      const norm = x => String(x).toLowerCase().replace(/^0x/, '');
      if (norm(got) !== norm(want)) return { ok: false, reason: `binding mismatch: ${k}` };
    }
    return { ok: true, signer: recovered };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** Convenience: verify an attestation covers exactly these delivered bytes. */
export function verifyDelivery(att, bytes, expect = {}) {
  return verifyAttestation(att, { ...expect, payloadHash: payloadHash(bytes) });
}

export default { notarize, verifyAttestation, verifyDelivery, payloadHash, dealIdHash, KINDS, NOTARY_DOMAIN };
