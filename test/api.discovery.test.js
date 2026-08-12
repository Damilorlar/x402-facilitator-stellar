import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Keypair } from '@stellar/stellar-sdk';

function startServer(env) {
  return new Promise((resolve, reject) => {
    const serverProcess = spawn('node', ['src/server.js'], {
      env: { ...process.env, ...env },
      cwd: join(import.meta.dirname, '..')
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

test('GET /discovery/resources tests', async (t) => {
  const PORT = 3411;
  const env = { 
    PORT: PORT.toString(),
    FACILITATOR_SECRET: Keypair.random().secret(),
  };
  
  const server = await startServer(env);
  
  t.after(() => {
    server.kill();
  });

  const baseUrl = `http://localhost:${PORT}`;

  await t.test('returns correctly shaped response', async () => {
    const res = await fetch(`${baseUrl}/discovery/resources?type=mcp&limit=50&offset=10`);
    assert.equal(res.status, 200);
    const json = await res.json();
    
    // Check field-for-field match with DiscoveryResourcesResponse
    assert.equal(json.x402Version, 2);
    assert.ok(Array.isArray(json.items));
    assert.equal(json.items.length, 0); // Empty because we haven't inserted anything
    
    assert.ok(json.pagination);
    assert.equal(json.pagination.limit, 50);
    assert.equal(json.pagination.offset, 10);
    assert.equal(json.pagination.total, 0);
  });
  
  await t.test('unknown filter values return empty page rather than error', async () => {
    const res = await fetch(`${baseUrl}/discovery/resources?payTo=UNKNOWN_PAY_TO_ADDRESS`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.items.length, 0);
  });
  
  await t.test('limit bounds are enforced', async () => {
    // 0 is clamped to 1
    let res = await fetch(`${baseUrl}/discovery/resources?limit=0`);
    let json = await res.json();
    assert.equal(json.pagination.limit, 1);
    
    // Default is 20
    res = await fetch(`${baseUrl}/discovery/resources`);
    json = await res.json();
    assert.equal(json.pagination.limit, 20);
    
    // Max is 100
    res = await fetch(`${baseUrl}/discovery/resources?limit=500`);
    json = await res.json();
    assert.equal(json.pagination.limit, 100);
  });
  
  await t.test('offset bounds are enforced', async () => {
    // Negative is clamped to 0
    let res = await fetch(`${baseUrl}/discovery/resources?offset=-5`);
    let json = await res.json();
    assert.equal(json.pagination.offset, 0);
    
    // Default is 0
    res = await fetch(`${baseUrl}/discovery/resources`);
    json = await res.json();
    assert.equal(json.pagination.offset, 0);
  });
  
  await t.test('multiple extensions parsed properly', async () => {
    const res = await fetch(`${baseUrl}/discovery/resources?extensions=ext1&extensions=ext2`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.items.length, 0);
  });
});
