import crypto from 'node:crypto';

// Domain separation: a leaf hash must never be confusable with an internal node
// hash, or a proof can be replayed with an inner node passed off as a leaf
// (classic Merkle second-preimage attack).
const LEAF_TAG = Buffer.from('airtight.v1.leaf\0', 'utf8');
const NODE_TAG = Buffer.from('airtight.v1.node\0', 'utf8');

const NONCE_BYTES = 16;

function sha256(...parts){
  const h = crypto.createHash('sha256');
  for(const p of parts) h.update(p);
  return h.digest();
}

// Canonical value encoding: objects get sorted keys so the same logical value
// always produces the same leaf regardless of insertion order.
export function canonical(value){
  // Strings are quoted like every other scalar, so the string "1" and the
  // number 1 never share a leaf. Returning strings raw would let a counterparty
  // re-present a numeric price as text against the same commitment.
  if(value === null || typeof value !== 'object') return JSON.stringify(value);
  if(Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

// Blinded leaf. Without the nonce a low-entropy field: a price, an address
// from a known set, a URL: is brute-forceable straight out of its hash, which
// defeats the point of withholding it.
export function leafHash(key, value, nonce){
  return sha256(
    LEAF_TAG,
    Buffer.from(`${key}\0${canonical(value)}\0`, 'utf8'),
    Buffer.from(nonce, 'hex')
  );
}

function nodeHash(a, b){ return sha256(NODE_TAG, a, b); }

export function newNonce(){ return crypto.randomBytes(NONCE_BYTES).toString('hex'); }

export function merkleRootFromLeaves(leafHashes){
  if(leafHashes.length === 0) return sha256(LEAF_TAG);
  let level = leafHashes.map(h=>Buffer.from(h));
  while(level.length > 1){
    const next = [];
    for(let i=0;i<level.length;i+=2){
      const a = level[i];
      const b = i+1 < level.length ? level[i+1] : level[i];
      next.push(nodeHash(a,b));
    }
    level = next;
  }
  return level[0];
}

export function getProof(leafHashes, index){
  const proof = [];
  let idx = index;
  let level = leafHashes.map(h=>Buffer.from(h));
  while(level.length > 1){
    const next = [];
    for(let i=0;i<level.length;i+=2){
      const a = level[i];
      const b = i+1 < level.length ? level[i+1] : level[i];
      next.push(nodeHash(a,b));
      if(i === idx || i+1 === idx){
        const selfIsLeft = (i === idx);
        proof.push({
          sibling: (selfIsLeft ? b : a).toString('hex'),
          isLeftSibling: !selfIsLeft
        });
      }
    }
    idx = Math.floor(idx/2);
    level = next;
  }
  return proof;
}

export function verifyProof(leafHashBuf, proof, rootHex){
  let cur = Buffer.from(leafHashBuf);
  for(const step of proof){
    const sibling = Buffer.from(step.sibling, 'hex');
    cur = step.isLeftSibling ? nodeHash(sibling, cur) : nodeHash(cur, sibling);
  }
  const got = Buffer.from(cur.toString('hex'), 'utf8');
  const want = Buffer.from(String(rootHex), 'utf8');
  if(got.length !== want.length) return false;
  return crypto.timingSafeEqual(got, want);
}

/**
 * Build the full commitment over an object. The result is PRIVATE to the
 * holder: it carries every nonce and every leaf hash. Only what
 * `selectDisclosure` returns is safe to hand to a counterparty.
 *
 * Store `root`, and nothing else from here: in the deal record.
 */
export function buildCommitment(obj){
  const keys = Object.keys(obj).sort();
  const entries = keys.map(k=>{
    const nonce = newNonce();
    return { key: k, value: obj[k], nonce, hash: leafHash(k, obj[k], nonce) };
  });
  const leafBufs = entries.map(e=>e.hash);
  const root = merkleRootFromLeaves(leafBufs).toString('hex');
  const proofs = {};
  entries.forEach((e,i)=>{ proofs[e.key] = getProof(leafBufs, i); });
  return {
    v: 1,
    root,
    fields: entries.map(e=>({
      key: e.key, value: e.value, nonce: e.nonce, leaf: e.hash.toString('hex')
    })),
    proofs
  };
}

/**
 * Produce the shareable blob revealing only `fields`. Undisclosed leaf hashes
 * and nonces never leave the holder: a recipient learns the field count (tree
 * shape) and nothing else about the withheld contents.
 */
export function selectDisclosure(commitment, fields){
  const disclosed = fields.map(k=>{
    const f = commitment.fields.find(x=>x.key === k);
    if(!f) throw new Error(`no such field in commitment: ${k}`);
    return { key: f.key, value: f.value, nonce: f.nonce, proof: commitment.proofs[k] };
  });
  return { v: 1, root: commitment.root, disclosed };
}

/**
 * Verify a disclosure blob against the root committed in the deal record.
 * Returns the verified key/value pairs, or throws.
 */
export function verifyDisclosure(blob, expectedRootHex){
  if(blob?.v !== 1) throw new Error('unsupported disclosure version');
  if(expectedRootHex && blob.root !== expectedRootHex){
    throw new Error('disclosure root does not match committed root');
  }
  const out = {};
  for(const d of blob.disclosed){
    const leaf = leafHash(d.key, d.value, d.nonce);
    if(!verifyProof(leaf, d.proof, blob.root)){
      throw new Error(`proof failed for field: ${d.key}`);
    }
    out[d.key] = d.value;
  }
  return out;
}

export function hex(buf){ return Buffer.from(buf).toString('hex'); }

export default {
  canonical, leafHash, newNonce, merkleRootFromLeaves, getProof, verifyProof,
  buildCommitment, selectDisclosure, verifyDisclosure, hex
};
