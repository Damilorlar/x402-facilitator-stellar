import assert from 'assert';
import { MemoryCatalogStore } from '../src/catalog/memory.js';

async function testIdentity() {
    const store = new MemoryCatalogStore();
    
    // HTTP resource
    await store.upsertResource({ type: 'http', url: 'http://api.ex/1', serviceName: 'A' });
    
    // MCP resources (same url, different tools)
    await store.upsertResource({ type: 'mcp', url: 'http://mcp.ex', toolName: 'tool1', serviceName: 'B' });
    await store.upsertResource({ type: 'mcp', url: 'http://mcp.ex', toolName: 'tool2', serviceName: 'C' });
    
    assert.strictEqual(store.resources.size, 3);
    
    const mcp1 = await store.getResource('http://mcp.ex', 'tool1');
    assert.strictEqual(mcp1.serviceName, 'B');
    
    console.log("✅ Catalog identity tests passed.");
}

testIdentity().catch(err => {
    console.error(err);
    process.exit(1);
});
