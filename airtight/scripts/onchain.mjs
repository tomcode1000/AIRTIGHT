#!/usr/bin/env node
/**
 * Prove a deal against the chain, not against our own logs.
 *
 * Reads the deal from memory, then reads Base for the transaction it recorded,
 * and checks the two agree. The last comparison is the one that matters: the
 * EIP-3009 nonce AIRTIGHT stored BEFORE paying is the nonce the token contract
 * burned. That is what makes the payment unrepeatable, and it is why the
 * authorisation has to be durable before the money moves.
 *
 * Usage: node scripts/onchain.mjs <deal_id>
 * Env:   AIRTIGHT_STORE / AIRTIGHT_MEMORY, BASE_RPC_URL
 */
import { FileDriver } from '../memory/driver-file.mjs';
import { SibylDriver } from '../memory/driver-sibyl.mjs';
import { DealMemory } from '../memory/deals.mjs';

const dealId = process.argv[2];
if (!dealId) { console.error('usage: node scripts/onchain.mjs <deal_id>'); process.exit(2); }

const RPC = process.env.BASE_RPC_URL || 'https://sepolia.base.org';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const driver = process.env.AIRTIGHT_MEMORY === 'file'
  ? new FileDriver(process.env.AIRTIGHT_STORE || '.airtight-memory')
  : new SibylDriver({ bin: process.env.SIBYL_MCP_BIN || 'sibyl-memory-mcp', db: process.env.SIBYL_MEMORY_DB || null });

const rpc = async (method, params) => {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};

const short = h => `${String(h).slice(0, 8)}…${String(h).slice(-6)}`;
const addr = topic => '0x' + String(topic).slice(26);

try {
  const mem = new DealMemory(driver);
  const deal = await mem.get(dealId);
  if (!deal) { console.log(`REFUSAL: no deal record for ${dealId}`); process.exit(3); }

  const tx = deal.payment?.tx_hash;
  if (!tx || !/^0x[0-9a-f]{64}$/i.test(tx)) {
    console.log(`deal ${dealId} is ${deal.state} with no settled tx to check`);
    process.exit(3);
  }

  const rc = await rpc('eth_getTransactionReceipt', [tx]);
  if (!rc) { console.log(`tx ${short(tx)} not found on ${RPC}`); process.exit(3); }

  const ok = rc.status === '0x1';
  console.log(`tx status    : ${ok ? 'SUCCESS' : 'FAILED'}   block ${Number(BigInt(rc.blockNumber))}`);

  const transfer = rc.logs.find(l => l.topics[0] === TRANSFER_TOPIC);
  if (transfer) {
    const amount = Number(BigInt(transfer.data)) / 1e6;
    console.log(`transfer     : ${short(addr(transfer.topics[1]))} → ${short(addr(transfer.topics[2]))}  ${amount} USDC`);
    const paidRight = addr(transfer.topics[2]).toLowerCase() === String(deal.terms.pay_to).toLowerCase();
    const paidAmount = String(Math.round(amount * 1e6)) === String(deal.terms.max_amount_required);
    console.log(`agreed terms : ${paidRight ? 'recipient ✓' : 'RECIPIENT MISMATCH ✗'}  ${paidAmount ? 'amount ✓' : 'AMOUNT MISMATCH ✗'}`);
  }

  // The buyer holds no ETH; whoever paid gas is the facilitator.
  console.log(`gas paid by  : ${short(rc.from)}  (facilitator — the buyer holds no ETH)`);

  // The claim, checked: what memory stored is what the chain consumed.
  const stored = deal.payment?.x402?.authorization?.nonce;
  const used = rc.logs.find(l => l.topics.length === 3 && l.topics[0] !== TRANSFER_TOPIC);
  if (stored && used) {
    const burned = used.topics[2];
    const match = stored.toLowerCase() === burned.toLowerCase();
    console.log(`nonce stored : ${stored}`);
    console.log(`nonce burned : ${burned}`);
    console.log(`MATCH        : ${match ? 'YES — this payment can never be repeated' : 'NO'}`);
    if (!match) process.exitCode = 1;
  } else if (!stored) {
    console.log('nonce stored : (none — this deal predates stored authorisations)');
  }
} finally {
  driver.close?.();
}
