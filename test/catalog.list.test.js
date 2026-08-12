import assert from 'assert';
import { MemoryCatalogStore } from '../src/catalog/memory.js';

async function run() {
  const store = new MemoryCatalogStore();

  await store.upsertResource({
    type: 'http',
    url: 'http://a',
    payTo: 'G1',
    scheme: 'exact',
    network: 'testnet',
    extensions: { ext1: true },
  });
  // Add small delay to ensure deterministic ordering by first_seen_at
  await new Promise(r => setTimeout(r, 10));
  await store.upsertResource({
    type: 'mcp',
    url: 'http://b',
    toolName: 't1',
    payTo: 'G2',
    scheme: 'upto',
    network: 'pubnet',
  });
  await new Promise(r => setTimeout(r, 10));
  await store.upsertResource({
    type: 'http',
    url: 'http://c',
    payTo: 'G1',
    scheme: 'exact',
    network: 'pubnet',
    extensions: { ext1: true, ext2: true },
  });

  // Test no filters
  let res = await store.listResources({});
  assert.strictEqual(res.total, 3);
  assert.strictEqual(res.items.length, 3);
  assert.strictEqual(res.items[0].url, 'http://c'); // most recent first

  // Test filter type
  res = await store.listResources({ type: 'mcp' });
  assert.strictEqual(res.total, 1);
  assert.strictEqual(res.items[0].url, 'http://b');

  // Test filter payTo
  res = await store.listResources({ payTo: 'G1' });
  assert.strictEqual(res.total, 2);

  // Test filter scheme and network composability
  res = await store.listResources({ scheme: 'exact', network: 'testnet' });
  assert.strictEqual(res.total, 1);
  assert.strictEqual(res.items[0].url, 'http://a');

  // Test extensions (must include all)
  res = await store.listResources({ extensions: ['ext1'] });
  assert.strictEqual(res.total, 2);

  res = await store.listResources({ extensions: ['ext1', 'ext2'] });
  assert.strictEqual(res.total, 1);
  assert.strictEqual(res.items[0].url, 'http://c');

  // Test pagination limit/offset
  res = await store.listResources({ limit: 1 });
  assert.strictEqual(res.total, 3); // total matches count before pagination
  assert.strictEqual(res.items.length, 1);
  assert.strictEqual(res.items[0].url, 'http://c');

  res = await store.listResources({ limit: 1, offset: 1 });
  assert.strictEqual(res.items.length, 1);
  assert.strictEqual(res.items[0].url, 'http://b');

  // Test unknown filter value
  res = await store.listResources({ payTo: 'UNKNOWN' });
  assert.strictEqual(res.total, 0);
  assert.strictEqual(res.items.length, 0);

  console.log('✅ Catalog list tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
