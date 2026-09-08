#!/usr/bin/env node
/**
 * airtight. Read the agent's own deal memory.
 *
 * This is the fresh-session recall surface: a brand-new process, no shared
 * state, reading only what reached storage. Everything printed is either read
 * from the record or recomputed from it: nothing is narrated from context,
 * which is the point. Hashes, not prose.
 *
 *   airtight ls
 *   airtight recall <deal_id>
 *   airtight verify <deal_id>
 *
 * Store defaults to ./.airtight-memory, or $AIRTIGHT_STORE.
 */
import { FileDriver } from './memory/driver-file.mjs';
import { SibylDriver } from './memory/driver-sibyl.mjs';
import { DealMemory } from './memory/deals.mjs';
import { assessDeal, termsHash, VERDICT } from './staging/selective_disclosure/resume.mjs';
import { verifyAttestation } from './staging/selective_disclosure/notary.mjs';

// Sibyl Memory is the substrate. FileDriver is a test double, selected only by
// an explicit AIRTIGHT_MEMORY=file, never the default, so the recall surface a
// judge runs reads the same store the agent wrote to.
const USE_FILE = process.env.AIRTIGHT_MEMORY === 'file';
const STORE = process.env.AIRTIGHT_STORE || '.airtight-memory';
const [cmd, arg] = process.argv.slice(2);

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { dim: s => `\x1b[2m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`,
      g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m` }
  : { dim: s => s, b: s => s, g: s => s, r: s => s, y: s => s };

const short = h => h ? `${String(h).replace(/^0x/, '').slice(0, 6)}…${String(h).slice(-4)}` : '-';
const driver = USE_FILE
  ? new FileDriver(STORE)
  : new SibylDriver({ bin: process.env.SIBYL_MCP_BIN || 'sibyl-memory-mcp', db: process.env.SIBYL_MEMORY_DB || null });
const mem = new DealMemory(driver);
const where = () => USE_FILE ? `file:${STORE}` : `sibyl:${driver.dbPath}`;

async function ls() {
  const ids = await mem.listDeals();
  if (!ids.length) return console.log(C.dim(`no deals in ${STORE}`));
  console.log(C.dim(`store ${STORE}\n`));
  for (const id of ids) {
    let d; try { d = await mem.get(id); } catch (e) { console.log(`  ${id}  ${C.r('CORRUPT')}`); continue; }
    console.log(`  ${id}  ${(d.state === 'CLOSED' ? C.g : d.state === 'DISPUTED' ? C.r : C.y)(d.state.padEnd(10))} ${C.dim(d.role)}`);
  }
}

async function recall(id) {
  let deal;
  try { deal = await mem.get(id); }
  catch (e) { console.log(C.r(`REFUSAL: ${e.message}`)); process.exit(3); }

  // The deletion beat lands here: no record, so nothing is claimed about it.
  if (!deal) {
    console.log(C.r(`REFUSAL: no verifiable deal state for ${id}.`));
    console.log(C.r('Refusing to sign or pay.'));
    process.exit(3);
  }

  const recomputed = termsHash(deal.terms);
  const termsOk = recomputed === String(deal.terms_hash).toLowerCase();

  console.log(`${C.b('AIRTIGHT')} ${C.dim('·')} deal ${C.b(deal.deal_id)}  ${C.dim('role')} ${deal.role}`);
  console.log(`${C.dim('state')}     ${(deal.state === 'CLOSED' ? C.g : deal.state === 'DISPUTED' ? C.r : C.y)(deal.state)}`);
  console.log(`${C.dim('terms')}     sha256 ${short(deal.terms_hash)}  ${termsOk ? C.g('recomputes ✓') : C.r('MISMATCH ✗')}`);
  console.log(`${C.dim('root')}      merkle ${short(deal.disclosure?.merkle_root)}  ${C.dim(`${deal.disclosure?.fields?.length ?? 0} fields committed`)}`);
  if (deal.authorization) console.log(`${C.dim('auth')}      payer ${short(deal.authorization.payer)}  ${C.dim(deal.authorization.authorized_at ?? '')}`);
  if (deal.payment) console.log(`${C.dim('payment')}   fp ${short(deal.payment.fingerprint)}  tx ${short(deal.payment.tx_hash)}  ${C.dim(deal.payment.settled_at ?? '')}`);
  if (deal.delivery) console.log(`${C.dim('delivery')}  sha256 ${short(deal.delivery.payload_sha256)}  ${C.dim(`${deal.delivery.bytes ?? '?'} bytes`)}`);

  console.log(`\n${C.dim('timeline')}`);
  for (const t of deal.transitions ?? []) console.log(`  ${t.to.padEnd(11)} ${C.dim(t.at)}`);

  const atts = await mem.getAttestations(id);
  if (Object.keys(atts).length) {
    console.log(`\n${C.dim('attestations')}`);
    for (const [kind, att] of Object.entries(atts)) {
      // The seller commits to its own blinded merkle root, so the buyer's root
      // is not a shared value and binding to it always fails. Check the three
      // things both sides derive identically: the payment fingerprint, the
      // terms hash, and the hash of the bytes actually delivered.
      const r = verifyAttestation(att, {
        dealId: deal.payment?.fingerprint,
        termsHash: deal.terms_hash,
        payloadHash: deal.delivery?.payload_sha256,
      });
      console.log(`  ${kind.padEnd(9)} signer ${short(att.signer)}  ${r.ok ? C.g('signature ✓') : C.r('signature ✗ ' + r.reason)}`);
    }
  }

  // Why it will not pay again, stated from the record rather than from memory
  // of the conversation.
  const a = assessDeal({ deal, attestations: atts });
  console.log(`\n${C.dim('on wake')}   ${a.verdict === VERDICT.RESUME ? C.g(a.verdict) : a.verdict === VERDICT.DISPUTED ? C.r(a.verdict) : C.y(a.verdict)} → ${a.action}${a.reason ? C.dim('  (' + a.reason + ')') : ''}`);
  if (deal.payment?.fingerprint) {
    const consumed = await mem.isConsumed(deal.payment.fingerprint);
    console.log(`${C.dim('replay')}    fingerprint ${short(deal.payment.fingerprint)} ${consumed ? C.g('consumed: a second payment is refused') : C.dim('unclaimed')}`);
  }
}

async function verify(id) {
  let deal; try { deal = await mem.get(id); } catch (e) { console.log(C.r(`REFUSAL: ${e.message}`)); process.exit(3); }
  const a = assessDeal({ deal, attestations: deal ? await mem.getAttestations(id) : {} });
  const colour = a.verdict === VERDICT.RESUME ? C.g : a.verdict === VERDICT.DISPUTED ? C.r : C.y;
  console.log(`${colour(a.verdict)}${a.reason ? ': ' + a.reason : ''}`);
  if (a.evidence) console.log(JSON.stringify(a.evidence, null, 2));
  process.exit(a.verdict === VERDICT.RESUME ? 0 : 3);
}

try {
switch (cmd) {
  case 'ls': await ls(); break;
  case 'recall': if (!arg) { console.log('usage: airtight recall <deal_id>'); process.exit(2); } await recall(arg); break;
  case 'verify': if (!arg) { console.log('usage: airtight verify <deal_id>'); process.exit(2); } await verify(arg); break;
  default:
    console.log('airtight. Read the agent\'s own deal memory\n');
    console.log('  airtight ls');
    console.log('  airtight recall <deal_id>');
    console.log('  airtight verify <deal_id>\n');
    console.log(`store: ${where()}`);
    console.log('       AIRTIGHT_MEMORY=file uses the local test driver instead');
}
} finally { driver.close?.(); }
