// ─────────────────────────────────────────────────────────────────────────────
// signer.mjs: pure-JS Ethereum signing for the x402 demo buyer.
// Zero dependencies: keccak-256 + secp256k1 (RFC6979) + EIP-3009 typed data.
// Scope: TESTNET demo buyer only. Never point a funded key at this file.
//
//   node src/payment/signer.mjs --selftest     # vectors + recover check
//   deriveAddress(privateKey)                  # checksummed address
//   signTransferWithAuthorization({...})       # EIP-3009 payload for x402
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'node:crypto';

/* ── keccak-256 (original Keccak padding 0x01, NOT NIST SHA3) ─────────────── */
const RC = [
  0x0000000000000001n,0x0000000000008082n,0x800000000000808an,0x8000000080008000n,
  0x000000000000808bn,0x0000000080000001n,0x8000000080008081n,0x8000000000008009n,
  0x000000000000008an,0x0000000000000088n,0x0000000080008009n,0x000000008000000an,
  0x000000008000808bn,0x800000000000008bn,0x8000000000008089n,0x8000000000008003n,
  0x8000000000008002n,0x8000000000000080n,0x000000000000800an,0x800000008000000an,
  0x8000000080008081n,0x8000000000008080n,0x0000000080000001n,0x8000000080008008n,
];
const ROT = [
  [ 0,36, 3,41,18],
  [ 1,44,10,45, 2],
  [62, 6,43,15,61],
  [28,55,25,21,56],
  [27,20,39, 8,14],
];
const M64 = 0xffffffffffffffffn;
const rotl64 = (x,n)=> n===0 ? x : ((x<<BigInt(n))|(x>>(64n-BigInt(n)))) & M64;

function keccakF(A){ // A: 5x5 lanes of BigInt, A[x][y]
  for(let round=0;round<24;round++){
    const C=[0n,0n,0n,0n,0n];
    for(let x=0;x<5;x++) C[x]=A[x][0]^A[x][1]^A[x][2]^A[x][3]^A[x][4];
    for(let x=0;x<5;x++){
      const d=C[(x+4)%5]^rotl64(C[(x+1)%5],1);
      for(let y=0;y<5;y++) A[x][y]^=d;
    }
    const B=[[0n,0n,0n,0n,0n],[0n,0n,0n,0n,0n],[0n,0n,0n,0n,0n],[0n,0n,0n,0n,0n],[0n,0n,0n,0n,0n]];
    for(let x=0;x<5;x++)for(let y=0;y<5;y++) B[y][(2*x+3*y)%5]=rotl64(A[x][y],ROT[x][y]);
    for(let x=0;x<5;x++)for(let y=0;y<5;y++)
      A[x][y]=B[x][y] ^ ((~B[(x+1)%5][y]) & B[(x+2)%5][y]) & M64;
    A[0][0]^=RC[round];
  }
}

export function keccak256(data){
  const bytes = typeof data==='string' ? Buffer.from(data,'utf8') : Buffer.from(data);
  const rate=136;
  const padded=Buffer.concat([bytes, Buffer.alloc(rate-(bytes.length%rate),0)]);
  padded[bytes.length]|=0x01; padded[padded.length-1]|=0x80;
  const A=Array.from({length:5},()=>Array(5).fill(0n));
  for(let off=0;off<padded.length;off+=rate){
    for(let i=0;i<17;i++){
      const x=i%5,y=(i/5)|0;
      let lane=0n;
      for(let b=7;b>=0;b--) lane=(lane<<8n)|BigInt(padded[off+i*8+b]);
      A[x][y]^=lane & M64;
    }
    keccakF(A);
  }
  const out=Buffer.alloc(32);
  for(let i=0;i<4;i++){
    let lane=A[i%5][(i/5)|0];
    for(let b=0;b<8;b++){ out[i*8+b]=Number(lane&0xffn); lane>>=8n; }
  }
  return out;
}

/* ── hex helpers ──────────────────────────────────────────────────────────── */
const toHex=b=>Buffer.from(b).toString('hex');
const pad32hex=n=>{
  if(typeof n==='bigint') return n.toString(16).padStart(64,'0');
  if(Buffer.isBuffer(n)) return n.toString('hex').padStart(64,'0');
  return BigInt(n).toString(16).padStart(64,'0');
};

/* ── secp256k1 ECDSA ──────────────────────────────────────────────────────── */
const P=0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const N=0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const Gx=0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const Gy=0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;

function modInv(a,m){
  let [old,r]=[a,m],[s,t]=[1n,0n];
  while(r!==0n){ const q=old/r; [old,r]=[r,old-q*r]; [s,t]=[t,s-q*t]; }
  return ((s%m)+m)%m;
}
function ecDouble(pt){
  if(!pt) return null;
  const [x,y]=pt;
  if(y===0n) return null;
  const m=(3n*x*x)*modInv(2n*y,P);
  const x3=m*m-2n*x, y3=m*(x-x3)-y;
  return [((x3%P)+P)%P,((y3%P)+P)%P];
}
function ecAdd(p1,p2){
  if(!p1) return p2; if(!p2) return p1;
  const [x1,y1]=p1,[x2,y2]=p2;
  if(x1===x2){
    if((y1+y2)%P===0n) return null;
    return ecDouble(p1);
  }
  const m=((y2-y1)*modInv(((x2-x1)%P+P)%P,P))%P;
  const x3=(m*m-x1-x2)%P, y3=(m*(x1-x3)-y1)%P;
  return [((x3%P)+P)%P,((y3%P)+P)%P];
}
function ecMul(k,[x,y]){
  let R=null,A=[x,y];
  while(k>0n){ if(k&1n) R=ecAdd(R,A); A=ecDouble(A); k>>=1n; }
  return R;
}
function recoverYfromX(x,isOdd){
  const y2=(x*x%P*x%P+7n)%P;
  let y=modPow(y2,(P+1n)/4n,P);           // p ≡ 3 mod 4 → sqrt via pow
  if((y%2n===(isOdd?1n:0n))===false) y=P-y;
  return ((y%P)+P)%P;
}
function modPow(b,e,m){ let r=1n;b%=m;while(e>0n){if(e&1n)r=r*b%m;b=b*b%m;e>>=1n;}return r; }

export function privateKeyToPubkey(privHex){
  const d=BigInt(privHex);
  return ecMul(d,[Gx,Gy]); // uncompressed pubkey coords
}
export function deriveAddress(privHex){
  return addressFromPubkey(privateKeyToPubkey(privHex));
}
/** AIRTIGHT addition: address from pubkey coords, so a VERIFIER (who has no
 *  private key) can derive the signer's address from a recovered point. */
export function addressFromPubkey([X,Y]){
  const raw=Buffer.concat([
    Buffer.from(X.toString(16).padStart(64,'0'),'hex'),
    Buffer.from(Y.toString(16).padStart(64,'0'),'hex'),
  ]);
  const h=keccak256(raw).toString('hex').slice(24); // last 20 bytes (12 hex-bytes = 24 chars)
  const lower=h.toLowerCase();
  const hash=keccak256(lower).toString('hex');
  let out='0x';
  for(let i=0;i<40;i++) out += parseInt(hash[i],16)>=8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

function rfc6979K(privHex,msgDigest){
  const x=BigInt(privHex);
  const xBytes=Buffer.from(x.toString(16).padStart(64,'0'),'hex');
  const h1=Buffer.from(msgDigest);                       // 32B digest
  const h1mod=Buffer.from(BigInt('0x'+h1.toString('hex')).toString(16).padStart(64,'0'),'hex'); // bits2octets
  let V=Buffer.alloc(32,0x01), K=Buffer.alloc(32,0x00);
  K=crypto.createHmac('sha256',K).update(Buffer.concat([V,Buffer.from([0]),xBytes,h1mod])).digest();
  V=crypto.createHmac('sha256',K).update(V).digest();
  K=crypto.createHmac('sha256',K).update(Buffer.concat([V,Buffer.from([1]),xBytes,h1mod])).digest();
  V=crypto.createHmac('sha256',K).update(V).digest();
  for(;;){
    V=crypto.createHmac('sha256',K).update(V).digest();
    const k=BigInt('0x'+V.toString('hex'));
    if(k>=1n&&k<N) return k;
    K=crypto.createHmac('sha256',K).update(Buffer.concat([V,Buffer.from([0])])).digest();
    V=crypto.createHmac('sha256',K).update(V).digest();
  }
}

/** Sign a 32-byte digest. Returns {r,s,v} with v∈{27,28}, low-s normalized. */
export function signDigest(privHex,digest){
  const z=BigInt('0x'+Buffer.from(digest).toString('hex'));
  const d=BigInt(privHex);
  for(;;){
    const k=rfc6979K(privHex,digest);
    const R=ecMul(k,[Gx,Gy]);
    if(!R) continue;
    let r=R[0]%N;
    if(r===0n) { /* astronomically rare */ }
    let s=(modInv(k,N)*(z+r*d))%N;
    if(s===0n) continue;
    let recid=R[1]&1n;
    if(R[0]>=N) recid|=2n;
    if(s>N>>1n){ s=N-s; recid^=1n; }
    return {r,s,v:Number(27n+recid)};
  }
}

/** Self-check: recover pubkey from sig and compare with derived pubkey. */
export function verifySelf(privHex,digest,{r,s,v}){
  const z=BigInt('0x'+Buffer.from(digest).toString('hex'));
  const yParity=BigInt(v-27);
  const xx=r + ((yParity&2n)===2n?N:0n);
  const isOdd=(yParity&1n)===1n;
  const Y=recoverYfromX(xx,isOdd);
  const R=[xx,Y];
  const rInv=modInv(r,N);
  const u1=((-z*rInv)%N+N)%N, u2=(s*rInv)%N;
  const Q=ecAdd(ecMul(u1,[Gx,Gy]),ecMul(u2,R));
  const dG=privateKeyToPubkey(privHex);
  return !!Q && Q[0]===dG[0] && Q[1]===dG[1];
}

/**
 * AIRTIGHT addition: public ECDSA recovery. Returns the signer's checksummed
 * address, or null if the signature is malformed / off-curve / high-s.
 *
 * A verifier holds no private key, so `verifySelf` above cannot serve them.
 * Rejecting high-s is deliberate: (r,s) and (r,N-s) are both valid ECDSA
 * signatures over the same digest, so accepting both would let anyone mint a
 * second distinct-looking signature for an attestation they did not author.
 */
export function recoverAddress(digest,{r,s,v}){
  const toBig=x=>typeof x==='bigint'?x:BigInt(x);
  let rB,sB;
  try { rB=toBig(r); sB=toBig(s); } catch { return null; }
  if(!(Number.isInteger(v)&&v>=27&&v<=30)) return null;
  if(rB<=0n||rB>=N||sB<=0n||sB>=N) return null;
  if(sB>N>>1n) return null;                       // malleability guard
  const z=BigInt('0x'+Buffer.from(digest).toString('hex'));
  const yParity=BigInt(v-27);
  const xx=rB+((yParity&2n)===2n?N:0n);
  if(xx>=P) return null;
  const Y=recoverYfromX(xx,(yParity&1n)===1n);
  if((Y*Y-(xx*xx%P*xx%P+7n))%P!==0n) return null; // r is not on the curve
  const rInv=modInv(rB,N);
  const u1=((-z*rInv)%N+N)%N, u2=(sB*rInv)%N;
  const Q=ecAdd(ecMul(u1,[Gx,Gy]),ecMul(u2,[xx,Y]));
  if(!Q) return null;
  return addressFromPubkey(Q);
}

/* ── EIP-3009 TransferWithAuthorization (USDC v2) ─────────────────────────── */
const DOMAIN_TYPEHASH=keccak256('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)');
const TRANSFER_TYPEHASH=keccak256('TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)');

export function signTransferWithAuthorization({ privateKey, from, to, valueUsdc, chainId, verifyingContract, ttlSeconds=300, tokenName='USD Coin', tokenVersion='2' }){
  const value=BigInt(Math.round(Number(valueUsdc)*1e6));
  const now=Math.floor(Date.now()/1000);
  const validAfter=now-60, validBefore=now+(ttlSeconds||300);
  const nonce=crypto.randomBytes(32);
  const domainSep=keccak256(Buffer.concat([
    Buffer.from(pad32hex(DOMAIN_TYPEHASH),'hex'),
    Buffer.from(pad32hex(keccak256(tokenName)),'hex'),
    Buffer.from(pad32hex(keccak256(tokenVersion)),'hex'),
    Buffer.from(pad32hex(BigInt(chainId)),'hex'),
    Buffer.from(pad32hex(verifyingContract.toLowerCase()),'hex'),
  ]));
  const structHash=keccak256(Buffer.concat([
    Buffer.from(pad32hex(TRANSFER_TYPEHASH),'hex'),
    Buffer.from(pad32hex(from.toLowerCase()),'hex'),
    Buffer.from(pad32hex(to.toLowerCase()),'hex'),
    Buffer.from(pad32hex(value),'hex'),
    Buffer.from(pad32hex(BigInt(validAfter)),'hex'),
    Buffer.from(pad32hex(BigInt(validBefore)),'hex'),
    Buffer.from(nonce),
  ]));
  const digest=keccak256(Buffer.concat([Buffer.from([0x19,0x01]),domainSep,structHash]));
  const {r,s,v}=signDigest(privateKey,digest);
  // x402 wire format: 65-byte hex string 0x<r(32B)><s(32B)><v(1B)>, NOT an {r,s,v}
  // object. The facilitator's viem parser calls .replace() on it (crash if object).
  return {
    authorization:{ from, to, value:value.toString(), validAfter:String(validAfter), validBefore:String(validBefore), nonce:'0x'+nonce.toString('hex') },
    signature:'0x'+r.toString(16).padStart(64,'0')+s.toString(16).padStart(64,'0')+v.toString(16).padStart(2,'0'),
    signatureParts:{ r:'0x'+r.toString(16).padStart(64,'0'), s:'0x'+s.toString(16).padStart(64,'0'), v, yParity:v-27 },
    _digest:toHex(digest),
  };
}

/* ── CLI self-test ────────────────────────────────────────────────────────── */
if(process.argv[2]==='--selftest'){
  const eq=(cond,label)=>{console.log(`${cond?'PASS':'FAIL'} ${label}`);if(!cond)process.exitCode=1;};
  eq(keccak256('abc').toString('hex')==='4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45','keccak256("abc") vector');
  eq(keccak256('The quick brown fox jumps over the lazy dog').toString('hex')==='4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15','keccak256(fox) vector');
  eq(keccak256('testing').toString('hex')==='5f16f4c7f149ac4f9510d9cf8cf384038ad348b3bcdc01915f95de12df9d1b02','keccak256(testing) vector');
  eq(deriveAddress('0x0000000000000000000000000000000000000000000000000000000000000001')==='0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf','address(priv=1) == canonical vector');
  const testKey='0x1111111111111111111111111111111111111111111111111111111111111111';
  console.log(`INFO test-key address: ${deriveAddress(testKey)}`);
  const dg=keccak256('selftest message');
  const sig=signDigest(testKey,dg);
  eq(sig.v>=27&&sig.v<=28,'v in {27,28}');
  eq(BigInt(sig.s)<=N>>1n,'low-s enforced');
  eq(verifySelf(testKey,dg,sig),'ECDSA recover(self) == pubkey');
  import('node:fs').then(fs=>{
    const env=fs.readFileSync(new URL('../../.env',import.meta.url),'utf8');
    const m=/DEMO_BUYER_KEY=(\S+)/.exec(env);
    if(m){
      const a=deriveAddress(m[1]);
      console.log(`INFO burner address : ${a}`);
      const sdg=keccak256('burner check');
      const ssig=signDigest(m[1],sdg);
      eq(verifySelf(m[1],sdg,ssig),'burner key ECDSA self-recover');
    }
  });
}
