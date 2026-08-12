-- migrations/001_bazaar_catalog.sql
CREATE TABLE IF NOT EXISTS discovery_resources (
    id SERIAL PRIMARY KEY,
    type VARCHAR(50) NOT NULL, -- 'http' or 'mcp'
    url TEXT NOT NULL,
    tool_name VARCHAR(255), -- NULL for http, populated for mcp
    service_name VARCHAR(255),
    description TEXT,
    tags JSONB DEFAULT '[]',
    mime_type VARCHAR(100),
    pay_to TEXT,
    network VARCHAR(50),
    scheme VARCHAR(50),
    pricing JSONB,
    extensions JSONB DEFAULT '{}',
    route_template TEXT,
    icon_url TEXT,
    first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_payment_at TIMESTAMP,
    source VARCHAR(50),
    
    -- Identity decision: Unique across type, url, and tool_name
    UNIQUE NULLS NOT DISTINCT (url, tool_name)
);

-- Indexes for ListDiscoveryResourcesParams
CREATE INDEX idx_discovery_resources_type ON discovery_resources(type);
CREATE INDEX idx_discovery_resources_tags ON discovery_resources USING GIN (tags);
CREATE INDEX idx_discovery_resources_last_seen ON discovery_resources(last_seen_at);
