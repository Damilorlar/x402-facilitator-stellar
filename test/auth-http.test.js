import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Keypair } from '@stellar/stellar-sdk';

function startServer(env) {
  return new Promise((resolve, reject) => {
    const serverProcess = spawn('node', ['src/server.js'], {
      env: { ...process.env, ...env },
      cwd: join(import.meta.dirname, '..'),
    });

    serverProcess.stdout.on('data', data => {
      if (data.toString().includes('listening on')) {
        resolve(serverProcess);
      }
    });

    serverProcess.stderr.on('data', data => {
      console.error(`server error: ${data}`);
    });

    serverProcess.on('error', err => reject(err));
  });
}

test('auth middleware tests', async t => {
  const PORT = 3409;
  const env = {
    PORT: PORT.toString(),
    FACILITATOR_SECRET: Keypair.random().secret(),
    FACILITATOR_API_KEYS: 'admin:supersecret',
  };

  const server = await startServer(env);

  t.after(() => {
    server.kill();
  });

  const baseUrl = `http://localhost:${PORT}`;

  await t.test('missing header', async () => {
    const res = await fetch(`${baseUrl}/verify`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.reason, 'missing_auth_header');
  });

  await t.test('malformed header', async () => {
    const res = await fetch(`${baseUrl}/verify`, {
      method: 'POST',
      body: '{}',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer token extra',
      },
    });
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.reason, 'malformed_auth_header');
  });

  await t.test('invalid key', async () => {
    const res = await fetch(`${baseUrl}/verify`, {
      method: 'POST',
      body: '{}',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wrongsecret',
      },
    });
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.reason, 'invalid_api_key');
  });

  await t.test('valid key (Bearer)', async () => {
    const res = await fetch(`${baseUrl}/verify`, {
      method: 'POST',
      body: '{}',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer supersecret',
      },
    });
    // It should pass auth and return 400 bad request from readPaymentBody
    assert.equal(res.status, 400);
  });

  await t.test('valid key (plain)', async () => {
    const res = await fetch(`${baseUrl}/verify`, {
      method: 'POST',
      body: '{}',
      headers: {
        'content-type': 'application/json',
        authorization: 'supersecret',
      },
    });
    assert.equal(res.status, 400);
  });
});

test('open mode tests', async t => {
  const PORT = 3410;
  const env = {
    PORT: PORT.toString(),
    FACILITATOR_SECRET: Keypair.random().secret(),
  };

  const server = await startServer(env);

  t.after(() => {
    server.kill();
  });

  const baseUrl = `http://localhost:${PORT}`;

  await t.test('passes without header', async () => {
    const res = await fetch(`${baseUrl}/verify`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.status, 400); // Bad request because body is empty, but auth passed
  });
});
