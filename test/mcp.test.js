import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/mcp/cli.js');

function createMcpClient(env) {
  const child = spawn(process.execPath, [CLI_PATH], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let messageId = 1;
  const pending = new Map();

  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          const { resolve, reject } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) {
            reject(new Error(msg.error.message));
          } else {
            resolve(msg.result);
          }
        }
      } catch {
        console.error('Failed to parse MCP response:', line);
      }
    }
  });

  return {
    callTool: (name, args) => {
      return new Promise((resolve, reject) => {
        const id = messageId++;
        pending.set(id, { resolve, reject });
        const req = JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: args },
        });
        child.stdin.write(req + '\n');
      });
    },
    close: () => {
      child.kill();
    },
  };
}

test('MCP Server Spending Controls', async t => {
  const client = createMcpClient({
    AGENT_PAYER_SECRET_KEY: 'SBUVX4M65C5HHKO2J75Y7EGBYJ2UHY4ZIVW5JDFOYY6AUPXUKOIMXG4T', // valid testnet key
    MAX_FEE_PER_CALL_STROOPS: '500',
    MAX_SESSION_SPEND_STROOPS: '1000',
  });

  // Since we don't have a real HTTP endpoint to hit in this unit test that returns 402,
  // we will rely on the fact that if it exceeds limits, it throws immediately before fetching,
  // or after fetching when reading 402 requirements.
  // Wait, the MCP server performs a fetch first (Unpaid). If the mock endpoint doesn't exist, it will throw fetch error.
  // We can mock an HTTP server to return a 402 with specific price.

  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    if (req.url === '/test-200-stroops') {
      res.writeHead(402, {
        'Content-Type': 'application/json',
      });
      res.end(
        JSON.stringify({
          error: 'payment_required',
          accepts: [
            {
              scheme: 'exact',
              network: 'stellar:testnet',
              price: { asset: 'native', amount: '200' },
              payTo: 'GBQ...',
            },
          ],
        }),
      );
    } else if (req.url === '/test-600-stroops') {
      res.writeHead(402, {
        'Content-Type': 'application/json',
      });
      res.end(
        JSON.stringify({
          error: 'payment_required',
          accepts: [
            {
              scheme: 'exact',
              network: 'stellar:testnet',
              price: { asset: 'native', amount: '600' },
              payTo: 'GBQ...',
            },
          ],
        }),
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const url600 = `http://localhost:${port}/test-600-stroops`;

  await t.test('enforces per-call cap (600 > 500)', async () => {
    try {
      await client.callTool('call_paid_resource', { url: url600 });
      // The tool result itself has isError: true when error is handled.
      // Wait, in my server implementation, if err.isToolError is true, it returns isError: true.
      // But my errors are standard Error, so they go to _sendError and reject!
      assert.fail('Should have rejected');
    } catch (err) {
      assert.match(err.message, /Spending refused.*exceeds per-call limit/);
    }
  });

  server.closeAllConnections();
  server.close();
  client.close();
});
