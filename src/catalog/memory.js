export class MemoryCatalogStore {
    constructor() {
        this.resources = new Map();
    }
    
    _key(resource) {
        return resource.type === 'mcp' 
            ? `${resource.url}::${resource.toolName}` 
            : `${resource.url}::`;
    }

    async upsertResource(resource, source = 'manual') {
        const key = this._key(resource);
        const existing = this.resources.get(key);
        
        const now = new Date();
        const entry = {
            ...existing,
            ...resource,
            source,
            last_seen_at: now,
            first_seen_at: existing ? existing.first_seen_at : now
        };
        
        this.resources.set(key, entry);
        return entry;
    }
    
    async getResource(url, toolName = null) {
        const key = toolName ? `${url}::${toolName}` : `${url}::`;
        return this.resources.get(key) || null;
    }
}
