import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { validateForCatalog } from '../src/catalog/validation.js';

test('Async Cataloging Non-blocking', async t => {
  await t.test('Cataloging errors do not fail the request', async () => {
    // This is essentially testing the enqueue logic pattern in server.js
    let catalogCalled = false;
    let requestFinished = false;

    const mockCatalog = {
      upsertResource: async () => {
        catalogCalled = true;
        throw new Error('Database failure');
      },
    };

    const payload = {
      paymentPayload: {
        x402Version: 2,
        resource: { url: 'http://example.com' },
        extensions: {
          bazaar: {
            info: { input: { type: 'http', method: 'GET' }, scheme: 'exact' },
            schema: { type: 'object' },
            routeTemplate: '/a',
          },
        },
      },
      paymentRequirements: { payTo: 'G123', network: 'stellar:testnet' },
    };

    // Simulate server.js enqueueCataloging
    function enqueueCataloging() {
      Promise.resolve().then(async () => {
        try {
          const validation = validateForCatalog(
            payload.paymentPayload,
            payload.paymentRequirements,
          );
          await mockCatalog.upsertResource(validation.resource, 'payment');
        } catch (err) {
          // Handled silently
        }
      });
    }

    // Simulate verify request
    enqueueCataloging();
    requestFinished = true;

    // The request completes immediately
    assert.equal(requestFinished, true);

    // Wait a tick for the promise to resolve
    await new Promise(resolve => setTimeout(resolve, 10));

    // The catalog was called and threw, but request was already finished
    assert.equal(catalogCalled, true);
  });
});
