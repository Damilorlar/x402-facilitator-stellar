/**
 * Horizon connection pooling and circuit breaking (#120).
 *
 * The keep-alive pool itself is undici's and is exercised indirectly (the
 * dispatcher it installs must pass a dispatcher option through). What is under
 * direct test is the circuit breaker lifecycle: trip after repeated failures,
 * fail fast while open, probe while half-open, close on recovery — per origin,
 * so one degraded backend never blocks another.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installHorizonClient } from '../src/horizon-client.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Installs the client with fast timings so state transitions are testable. */
function install(baseFetch) {
  const warns = [];
  const logs = [];
  const client = installHorizonClient({
    baseFetch,
    breakerTimeoutMs: 500,
    breakerErrorThreshold: 50,
    breakerResetTimeoutMs: 100,
    warn: m => warns.push(m),
    log: m => logs.push(m),
  });
  return { client, warns, logs };
}

describe('circuit breaker', () => {
  test('trips open after consecutive failures, then fails fast', async () => {
    const { client, warns } = install(async () => {
      throw new Error('ECONNRESET');
    });
    try {
      for (let i = 0; i < 5; i++) {
        await assert.rejects(fetch('https://rpc-backend.example/'));
      }

      // While open, requests fail fast without another backend attempt:
      // the failure count stops climbing.
      await assert.rejects(fetch('https://rpc-backend.example/'), /Breaker is open/);
      const { state, failures } = client.stats()['https://rpc-backend.example'];
      assert.equal(state, 'open');
      assert.ok(failures >= 3, `expected several recorded failures, got ${failures}`);
      assert.ok(warns.some(w => w.includes('OPEN')));
    } finally {
      client.restore();
    }
  });

  test('half-open probes recover to closed when the backend heals', async () => {
    let healthy = false;
    const { client, logs } = install(async () => {
      if (!healthy) throw new Error('ETIMEDOUT');
      return new Response('{}', { status: 200 });
    });
    try {
      for (let i = 0; i < 4; i++) {
        await assert.rejects(fetch('https://horizon.example/'));
      }
      assert.equal(client.stats()['https://horizon.example'].state, 'open');

      healthy = true;
      // Wait out the reset timeout: the breaker goes half-open and lets a
      // single probe through.
      await sleep(150);
      const res = await fetch('https://horizon.example/');
      assert.equal(res.status, 200);

      // Recovery closes the circuit.
      await sleep(10);
      assert.equal(client.stats()['https://horizon.example'].state, 'closed');
      assert.ok(logs.some(l => l.includes('CLOSED')));
      assert.ok(logs.some(l => l.includes('HALF-OPEN')));
    } finally {
      client.restore();
    }
  });

  test('breakers are per origin — testnet trouble does not block pubnet', async () => {
    const { client } = install(async () => {
      throw new Error('EAI_AGAIN');
    });
    try {
      for (let i = 0; i < 4; i++) {
        await assert.rejects(fetch('https://testnet-rpc.example/'));
      }
      assert.equal(client.stats()['https://testnet-rpc.example'].state, 'open');

      // A different origin has its own breaker, untouched by the failures.
      await assert.rejects(fetch('https://pubnet-rpc.example/'), /EAI_AGAIN/);
      assert.equal(client.stats()['https://pubnet-rpc.example'].state, 'closed');
    } finally {
      client.restore();
    }
  });

  test('restore() puts the original fetch back', async () => {
    const original = globalThis.fetch;
    const { client } = install(async () => new Response('{}', { status: 200 }));
    assert.notEqual(globalThis.fetch, original);
    client.restore();
    assert.equal(globalThis.fetch, original);
  });
});
