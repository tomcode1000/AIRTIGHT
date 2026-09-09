/**
 * Print the settled transaction hash for one deal, or nothing.
 *
 *   node web/tx-of.mjs <deal_ref>
 *
 * This exists as its own process rather than a function call because a memory
 * driver constructed inside the long-lived public server does not return. A
 * fresh process reads the same store reliably, which is the same property the
 * recall surface relies on, so the lookup is done the way that is known to work
 * instead of the way that is tidier.
 *
 * Output is one line of JSON on stdout so the caller does not have to parse
 * prose, and every failure is silent: a missing hash is not an error, it just
 * means there is nothing to link to yet.
 */
import { SibylDriver } from '../memory/driver-sibyl.mjs';
import { FileDriver } from '../memory/driver-file.mjs';
import { DealMemory } from '../memory/deals.mjs';

const ref = process.argv[2];
if (!ref) process.exit(0);

const driver = process.env.AIRTIGHT_MEMORY === 'file'
  ? new FileDriver(process.env.AIRTIGHT_STORE || '.airtight-memory')
  : new SibylDriver({ bin: process.env.SIBYL_MCP_BIN || 'sibyl-memory-mcp', db: process.env.SIBYL_MEMORY_DB || null });

try {
  const deal = await new DealMemory(driver).get(ref);
  if (deal) {
    process.stdout.write(JSON.stringify({
      state: deal.state ?? null,
      tx: deal.payment?.tx_hash ?? null,
      fingerprint: deal.payment?.fingerprint ?? null,
    }));
  }
} catch { /* silent by design */ }
process.exit(0);
