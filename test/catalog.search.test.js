import test from 'node:test';
import assert from 'node:assert';
import { MemoryCatalogStore } from '../src/catalog/memory.js';

test('Catalog search tests', async t => {
  const store = new MemoryCatalogStore();

  await store.upsertResource(
    {
      url: 'https://example.com/api',
      serviceName: 'Weather API',
      description: 'Get current weather',
      tags: ['weather', 'forecast'],
      type: 'http',
      payTo: 'G123',
      scheme: 'exact',
      network: 'stellar:pubnet',
      extensions: {
        bazaar: { info: 'bazaar config' },
        custom: { description: 'secret token parameter' },
      },
    },
    'payment',
  );

  await new Promise(r => setTimeout(r, 10)); // Ensure different first_seen_at

  await store.upsertResource(
    {
      url: 'https://example.com/api2',
      serviceName: 'Finance API',
      description: 'Get stock prices',
      tags: ['finance', 'stock'],
      type: 'http',
      payTo: 'G123',
      scheme: 'exact',
      network: 'stellar:pubnet',
    },
    'manual',
  );

  await t.test('conforms to response shape', async () => {
    const res = await store.search({ query: 'api' });
    assert.ok(res.resources, 'Has resources array');
    assert.ok(res.pagination, 'Has pagination');
    assert.strictEqual(res.total, undefined, 'Does not have total');
    assert.strictEqual(res.resources.length, 2);
    assert.strictEqual(res.partialResults, true); // true because no embedding provider is configured
  });

  await t.test('filters compose with query', async () => {
    const res = await store.search({ query: 'api', extensions: ['custom'] });
    assert.strictEqual(res.resources.length, 1);
    assert.strictEqual(res.resources[0].serviceName, 'Weather API');
  });

  await t.test('extensions are indexed', async () => {
    const res = await store.search({ query: 'secret token' });
    assert.strictEqual(res.resources.length, 1);
    assert.strictEqual(res.resources[0].serviceName, 'Weather API');
  });

  await t.test('ranking: payment outranks manual', async () => {
    await store.upsertResource(
      {
        url: 'https://example.com/api3',
        serviceName: 'Weather API 2',
        type: 'http',
      },
      'manual',
    );
    const res = await store.search({ query: 'weather' });
    assert.strictEqual(res.resources[0].serviceName, 'Weather API');
    assert.strictEqual(res.resources[1].serviceName, 'Weather API 2');
  });

  await t.test('cursor pagination works', async () => {
    // Should get first page
    const page1 = await store.search({ query: 'api', limit: 1 });
    assert.strictEqual(page1.resources.length, 1);
    assert.ok(page1.pagination.cursor, 'First page returns cursor');

    // Should get second page using cursor
    const page2 = await store.search({ query: 'api', limit: 1, cursor: page1.pagination.cursor });
    assert.strictEqual(page2.resources.length, 1);
    assert.notStrictEqual(page1.resources[0].url, page2.resources[0].url);
  });

  await t.test('partialResults is truthful (true when provider is unavailable)', async () => {
    const res = await store.search({ query: 'api' });
    assert.strictEqual(res.partialResults, true);
  });
});
