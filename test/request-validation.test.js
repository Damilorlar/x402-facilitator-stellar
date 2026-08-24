import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePaymentBody } from '../src/request-validation.js';

const config = { networks: ['stellar:testnet'] };

const VALID_REQUIREMENTS = {
  scheme: 'exact',
  network: 'stellar:testnet',
  asset: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  maxAmountRequired: '1000',
  payTo: 'GCALKSGAZRJLSUEJT3M5W6LN4R7XQOLIRCOS6ZA6EDZVTZDBIIPPFKJ6',
};

const VALID_PAYLOAD = {
  x402Version: 2,
  scheme: 'exact',
  network: 'stellar:testnet',
  payload: { transaction: 'AAAAAgAAAA...' },
};

test('accepts a conformant body unchanged', () => {
  const result = validatePaymentBody(
    { paymentPayload: VALID_PAYLOAD, paymentRequirements: VALID_REQUIREMENTS },
    config,
  );
  assert.equal(result.valid, true);
  assert.deepEqual(result.paymentPayload, VALID_PAYLOAD);
  assert.deepEqual(result.paymentRequirements, VALID_REQUIREMENTS);
});

test('rejects a missing paymentPayload', () => {
  const result = validatePaymentBody({ paymentRequirements: VALID_REQUIREMENTS }, config);
  assert.equal(result.valid, false);
  assert.equal(result.field, 'paymentPayload');
  assert.equal(result.reason, 'invalid_request');
  assert.ok(result.message);
});

for (const bad of ['a string', 42, true, null, ['array'], undefined]) {
  test(`rejects paymentPayload of type ${typeof bad} (${JSON.stringify(bad)})`, () => {
    const result = validatePaymentBody(
      { paymentPayload: bad, paymentRequirements: VALID_REQUIREMENTS },
      config,
    );
    assert.equal(result.valid, false);
    assert.equal(result.field, 'paymentPayload');
    assert.equal(result.reason, 'invalid_request');
  });
}

test('rejects a non-object paymentRequirements', () => {
  const result = validatePaymentBody(
    { paymentPayload: VALID_PAYLOAD, paymentRequirements: 'nope' },
    config,
  );
  assert.equal(result.valid, false);
  assert.equal(result.field, 'paymentRequirements');
  assert.equal(result.reason, 'invalid_request');
});

test('rejects paymentRequirements.scheme that is missing or not a string', () => {
  const result = validatePaymentBody(
    {
      paymentPayload: VALID_PAYLOAD,
      paymentRequirements: { ...VALID_REQUIREMENTS, scheme: 123 },
    },
    config,
  );
  assert.equal(result.valid, false);
  assert.equal(result.field, 'paymentRequirements.scheme');
  assert.equal(result.reason, 'invalid_request');
});

test('rejects a network outside config.networks with a distinct reason', () => {
  const result = validatePaymentBody(
    {
      paymentPayload: VALID_PAYLOAD,
      paymentRequirements: { ...VALID_REQUIREMENTS, network: 'stellar:pubnet' },
    },
    config,
  );
  assert.equal(result.valid, false);
  assert.equal(result.field, 'paymentRequirements.network');
  assert.equal(result.reason, 'unsupported_network');
  // Must be distinct from invalid_request so a client can branch on it.
  assert.notEqual(result.reason, 'invalid_request');
});

test('does not inspect paymentPayload.payload at all', () => {
  // An unrecognised or oddly-shaped field inside payload must never cause a
  // rejection here — that is the scheme's contract, not the transport's.
  const payload = {
    ...VALID_PAYLOAD,
    payload: { transaction: 'AAAAAgAAAA...', somethingUpstreamMightAddLater: [1, 2, 3] },
  };
  const result = validatePaymentBody(
    { paymentPayload: payload, paymentRequirements: VALID_REQUIREMENTS },
    config,
  );
  assert.equal(result.valid, true);
  assert.deepEqual(result.paymentPayload.payload, payload.payload);
});
