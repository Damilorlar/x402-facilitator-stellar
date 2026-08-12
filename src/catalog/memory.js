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
    async listResources(params = {}) {
        let items = Array.from(this.resources.values());

        if (params.type) items = items.filter(r => r.type === params.type);
        if (params.payTo) items = items.filter(r => r.payTo === params.payTo);
        if (params.scheme) items = items.filter(r => r.scheme === params.scheme);
        if (params.network) items = items.filter(r => r.network === params.network);
        if (params.extensions && Array.isArray(params.extensions)) {
            items = items.filter(r => {
                const resourceExts = Object.keys(r.extensions || {});
                return params.extensions.every(ext => resourceExts.includes(ext));
            });
        }

        // Sort by first_seen_at desc, then key asc to ensure deterministic order
        items.sort((a, b) => {
            const timeDiff = b.first_seen_at.getTime() - a.first_seen_at.getTime();
            if (timeDiff !== 0) return timeDiff;
            const keyA = this._key(a);
            const keyB = this._key(b);
            return keyA.localeCompare(keyB);
        });

        const total = items.length;
        
        let parsedLimit = parseInt(params.limit, 10);
        if (isNaN(parsedLimit)) parsedLimit = 20;
        
        let parsedOffset = parseInt(params.offset, 10);
        if (isNaN(parsedOffset)) parsedOffset = 0;

        const limit = Math.min(Math.max(1, parsedLimit), 100);
        const offset = Math.max(0, parsedOffset);

        return {
            items: items.slice(offset, offset + limit),
            total
        };
    }
}
