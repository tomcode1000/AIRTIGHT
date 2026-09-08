import fs from 'node:fs';
import path from 'node:path';
import { buildCommitment, selectDisclosure, verifyDisclosure } from './merkle.js';

// A deal record with fields a counterparty has no business seeing.
const deal = {
  deal_id: 'dt-1693720000-ab12',
  role: 'buyer',
  resource_url: 'https://example.com/secret-resource/123',
  seller: '0xSellerAddressSensitive',
  price_usdc: 0.25,
  network: 'base-sepolia',
  created_at: new Date().toISOString()
};

// 1. At deal time the buyer commits. Only `root` goes into the deal record.
const commitment = buildCommitment(deal);
console.log('committed root:', commitment.root);

// 2. Later: a dispute, an audit: reveal just what's needed.
const blob = selectDisclosure(commitment, ['price_usdc', 'created_at']);

// 3. The adjudicator verifies against the root they already hold.
const verified = verifyDisclosure(blob, commitment.root);
console.log('verified fields:', verified);

// What the counterparty receives contains no trace of the withheld fields.
const outDir = path.resolve(import.meta.dirname, '../../data');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'disclosure-example.json');
fs.writeFileSync(outFile, JSON.stringify(blob, null, 2));
console.log('wrote shareable blob to', outFile);

const wire = JSON.stringify(blob);
for(const secret of [deal.seller, deal.resource_url, deal.deal_id]){
  console.log(`  leaks ${secret.slice(0, 24)}… :`, wire.includes(secret));
}
