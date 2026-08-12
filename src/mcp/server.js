import { createInterface } from 'readline';

/**
 * Minimal MCP Stdio Server
 */
export class McpServer {
  constructor({ name, version }) {
    this.name = name;
    this.version = version;
    this.tools = new Map();
  }

  tool(name, schema, handler) {
    this.tools.set(name, { schema, handler });
  }

  async start() {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    rl.on('line', async line => {
      if (!line.trim()) return;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        this._sendError(null, -32700, 'Parse error');
        return;
      }

      try {
        await this._handleRequest(req);
      } catch (err) {
        this._sendError(req.id, -32603, 'Internal error', err.message);
      }
    });
  }

  async _handleRequest(req) {
    if (req.method === 'initialize') {
      this._sendResult(req.id, {
        protocolVersion: '2024-11-05',
        serverInfo: { name: this.name, version: this.version },
        capabilities: { tools: {} },
      });
    } else if (req.method === 'tools/list') {
      const tools = Array.from(this.tools.entries()).map(([name, { schema }]) => ({
        name,
        description: schema.description || '',
        inputSchema: {
          type: 'object',
          properties: schema.properties || {},
          required: schema.required || [],
        },
      }));
      this._sendResult(req.id, { tools });
    } else if (req.method === 'tools/call') {
      const toolName = req.params?.name;
      const toolArgs = req.params?.arguments || {};
      const tool = this.tools.get(toolName);

      if (!tool) {
        this._sendError(req.id, -32601, 'Method not found');
        return;
      }

      try {
        const result = await tool.handler(toolArgs);
        this._sendResult(req.id, {
          content: [
            {
              type: 'text',
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            },
          ],
          isError: false,
        });
      } catch (err) {
        // Return structured errors inside the MCP tool result where possible
        if (err.isToolError) {
          this._sendResult(req.id, {
            content: [{ type: 'text', text: JSON.stringify(err.payload || err.message, null, 2) }],
            isError: true,
          });
        } else {
          this._sendError(req.id, -32603, err.message);
        }
      }
    } else if (req.method === 'ping') {
      this._sendResult(req.id, {});
    } else if (req.method === 'notifications/initialized') {
      // no response needed
    } else {
      if (req.id !== undefined) {
        this._sendError(req.id, -32601, 'Method not found');
      }
    }
  }

  _sendResult(id, result) {
    const res = { jsonrpc: '2.0', id, result };
    process.stdout.write(JSON.stringify(res) + '\n');
  }

  _sendError(id, code, message, data) {
    const res = { jsonrpc: '2.0', id, error: { code, message, data } };
    process.stdout.write(JSON.stringify(res) + '\n');
  }
}
