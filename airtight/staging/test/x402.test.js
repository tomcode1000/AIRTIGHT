import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.X402_NETWORK = 'base-sepolia';
process.env.X402_PAY_TO = '0xABC0000000000000000000000000000000000abc';
process.env.X402_PRICE_USDC = '25';
const x402 = await import('../src/payment/x402.js');

describe('x402 protocol module', () => {
  test('requirements: exact scheme, micro-USDC amount, correct asset address', () => {
    const reqs = x402.buildPaymentRequirements('http://agent.example/v1/requests');
    assert.equal(reqs.x402Version, 1);
    const a = reqs.accepts[0];
    assert.equal(a.scheme, 'exact');
    assert.equal(a.network, 'base-sepolia');
    assert.equal(a.maxAmountRequired, '25000000'); // 25 USDC × 1e6
    assert.equal(a.payTo, '0xABC0000000000000000000000000000000000abc');
    assert.equal(a.asset, '0x036CbD53842c5426634e7929541eC2318f3dCF7e'); // base-sepolia USDC
    assert.ok(a.resource.startsWith('http://agent.example'));
  });

  test('mainnet network selects mainnet USDC', () => {
    process.env.X402_NETWORK = 'base';
    const reqs = x402.buildPaymentRequirements('http://x/v1/requests');
    assert.equal(reqs.accepts[0].asset, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    process.env.X402_NETWORK = 'base-sepolia';
  });

  test('decodePaymentHeader: valid / malformed / missing payload', () => {
    const good = Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: 'exact',
        network: 'base-sepolia',
        payload: {
          signature: '0xsig',
          authorization: { from: '0xpayer', to: '0xpayee', value: '25000000' },
        },
      })
    ).toString('base64');
    const decoded = x402.decodePaymentHeader(good);
    assert.equal(decoded.payload.authorization.from, '0xpayer');

    const garbage = Buffer.from('not json at all').toString('base64');
    assert.equal(x402.decodePaymentHeader(garbage), null);
    assert.equal(x402.decodePaymentHeader('!!!'), null);

    const noPayload = Buffer.from(JSON.stringify({ scheme: 'exact' })).toString('base64');
    assert.equal(x402.decodePaymentHeader(noPayload), null);
  });

  test('mock facilitator: verify accepts well-formed header, rejects malformed', async () => {
    process.env.PAYMENT_MODE = 'x402-mock';
    const reqs = x402.buildPaymentRequirements('http://x/v1/requests');

    const goodHeader = Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: 'exact',
        network: 'base-sepolia',
        payload: {
          signature: '0xsig',
          authorization: { from: '0xclientwallet', to: '0xpayee', value: '25000000' },
        },
      })
    ).toString('base64');

    const ok = await x402.verifyPayment(goodHeader, reqs);
    assert.equal(ok.isValid, true);
    assert.equal(ok.payer, '0xclientwallet');

    const bad = await x402.verifyPayment(Buffer.from('{}').toString('base64'), reqs);
    assert.equal(bad.isValid, false);
    assert.ok(bad.invalidReason.includes('malformed'));

    const settle = await x402.settlePayment(goodHeader, reqs);
    assert.equal(settle.receipt.success, true);
    assert.ok(settle.headerValue.length > 10);
    // receipt round-trips through the response header encoding
    const back = JSON.parse(Buffer.from(settle.headerValue, 'base64').toString('utf8'));
    assert.equal(back.transaction, '0x_mock_settlement');
  });
});

describe('x402 replay guard', () => {
  const mkHeader = (from) =>
    Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: 'exact',
        network: 'base-sepolia',
        payload: {
          signature: `0xsig-${from}`,
          authorization: { from, to: '0xpayee', value: '25000000' },
        },
      })
    ).toString('base64');

  test('unseen header passes; marked header is flagged as replay', () => {
    const h = mkHeader('0xrepeater');
    assert.equal(x402.paymentAlreadyUsed(h), false);
    x402.markPaymentUsed(h, '0xrepeater');
    assert.equal(x402.paymentAlreadyUsed(h), true);
  });

  test('different payer/signature = different nonce (not collaterally blocked)', () => {
    assert.equal(x402.paymentAlreadyUsed(mkHeader('0xotherpayer')), false);
  });

  test('forgetPayment releases the nonce for retry', () => {
    const h = mkHeader('0xforgotten');
    x402.markPaymentUsed(h, '0xforgotten');
    assert.equal(x402.paymentAlreadyUsed(h), true);
    x402.forgetPayment(h);
    assert.equal(x402.paymentAlreadyUsed(h), false);
  });

  test('malformed headers are never "used"', () => {
    assert.equal(x402.paymentAlreadyUsed('garbage!!'), false);
    x402.markPaymentUsed('garbage!!'); // no-op, must not throw
    assert.equal(x402.paymentAlreadyUsed('garbage!!'), false);
  });
});
