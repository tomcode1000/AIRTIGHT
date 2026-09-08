#!/usr/bin/env node
/**
 * Generate burner wallets for the demo and print the .env lines to add.
 *
 * Keys are printed to stdout and never written to a tracked file. `.env` is
 * gitignored; nothing here may reach the repo. These are throwaway testnet
 * wallets. Do not reuse them for anything holding real value.
 */
import crypto from 'node:crypto';
import { deriveAddress } from '../staging/x402/signer.mjs';

function burner() {
  // Reject the vanishingly unlikely out-of-range key rather than emit one that
  // secp256k1 would refuse later.
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  for (;;) {
    const k = '0x' + crypto.randomBytes(32).toString('hex');
    const v = BigInt(k);
    if (v > 0n && v < N) return { key: k, address: deriveAddress(k) };
  }
}

const buyer = burner();
const seller = burner();

console.log(`# --- AIRTIGHT demo burners (testnet only) ---
# Generated ${new Date().toISOString()}
# Append to .env (gitignored). NEVER commit these.

X402_NETWORK=base-sepolia
PAYMENT_MODE=x402-mock          # flip to x402-live for the real settle

# Buyer: needs Base Sepolia USDC ONLY. No ETH: the buyer signs an EIP-3009
# authorisation offline and never broadcasts; the facilitator submits and pays gas.
DEMO_BUYER_KEY=${buyer.key}
DEMO_BUYER_ADDRESS=${buyer.address}

# Seller: receives the USDC. Only the ADDRESS is needed to run the seller.
X402_PAY_TO=${seller.address}
DEMO_SELLER_KEY=${seller.key}

X402_PRICE_USDC=0.01
X402_FACILITATOR_URL=https://x402.org/facilitator
`);

console.error(`
Fund the buyer with Base Sepolia USDC: USDC only, no ETH needed:
  address : ${buyer.address}
  token   : 0x036CbD53842c5426634e7929541eC2318f3dCF7e  (USDC, base-sepolia)
  faucet  : https://faucet.circle.com  (select Base Sepolia)

The seller needs no funds - it only receives.
At X402_PRICE_USDC=0.01 a deal costs one cent, so 10 USDC is ~1000 takes.
`);
