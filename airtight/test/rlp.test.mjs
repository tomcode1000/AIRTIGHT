import { rlp, num, splitSig } from '../x402/settle.mjs';
const hex = b => b.toString('hex');
let bad = 0;
const eq = (a, b, l) => { const ok = a === b; if (!ok) bad++; console.log(`${ok ? '  ok   ' : '  FAIL '}${l}${ok ? '' : `   got ${a} want ${b}`}`); };
// canonical RLP vectors from the yellow paper / ethereum tests
eq(hex(rlp(Buffer.from('dog'))), '83646f67', 'rlp("dog")');
eq(hex(rlp([Buffer.from('cat'), Buffer.from('dog')])), 'c88363617483646f67', 'rlp([cat,dog])');
eq(hex(rlp(Buffer.alloc(0))), '80', 'rlp(empty string)');
eq(hex(rlp([])), 'c0', 'rlp([])');
eq(hex(rlp(Buffer.from([0x0f]))), '0f', 'single byte below 0x80 is itself');
eq(hex(rlp(Buffer.from([0x04, 0x00]))), '820400', 'rlp(0x0400)');
eq(hex(rlp(Buffer.from('Lorem ipsum dolor sit amet, consectetur adipisicing elit'))),
   'b8384c6f72656d20697073756d20646f6c6f722073697420616d65742c20636f6e7365637465747572206164697069736963696e6720656c6974',
   'rlp(55 byte string) uses the long form');
eq(hex(num(0)), '', 'num(0) is empty, not 0x00');
eq(hex(num(1024)), '0400', 'num(1024)');
eq(hex(num(15)), '0f', 'num(15)');
const s = splitSig('0x' + 'aa'.repeat(32) + 'bb'.repeat(32) + '1b');
eq(String(s.v), '27', 'signature v');
eq(s.r.toString(16).slice(0, 4), 'aaaa', 'signature r');
eq(s.s.toString(16).slice(0, 4), 'bbbb', 'signature s');
console.log(bad ? `\n${bad} FAILED` : '\nall RLP vectors pass');
process.exit(bad ? 1 : 0);
