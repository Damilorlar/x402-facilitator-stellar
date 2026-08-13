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
  child.stderr.on('data', d => process.stderr.write(d));

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

  child.on('exit', (code) => {
    for (const { reject } of pending.values()) {
      reject(new Error(`Child exited with code ${code}`));
    }
    pending.clear();
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
    AGENT_PAYER_SECRET_KEY: 'SBTJBX7IF3W4IU2VRQXK2PPEAQJW5PZTRUQPL4CVIBEL42OE3YLETWWW', // valid testnet key
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
          x402Version: 1,
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
          x402Version: 1,
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
      console.log('Sending call_paid_resource...');
      await client.callTool('call_paid_resource', { url: url600 });
      console.log('Received response from call_paid_resource, failing test');
      assert.fail('Should have rejected');
    } catch (err) {
      console.log('Caught error:', err.message);
      assert.match(err.message, /Spending refused.*exceeds per-call limit/);
    }
  });

  server.closeAllConnections();
  server.close();
  client.close();
});
