import { Keypair } from '@stellar/stellar-sdk';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Helper to setup and fund a testnet keypair for the agent to pay with
 */
async function setupAgentAccount() {
  const envSecret = process.env.AGENT_PAYER_SECRET_KEY;
  if (envSecret) {
    console.log(`[setup] Using configured AGENT_PAYER_SECRET_KEY.`);
    return envSecret;
  }

  const keyPath = '.agent-secret';
  let secret;
  if (fs.existsSync(keyPath)) {
    secret = fs.readFileSync(keyPath, 'utf8').trim();
    console.log(`[setup] Using existing agent account from ${keyPath}.`);
    return secret;
  }

  console.log(
    '[setup] No agent account configured. Generating a new one and funding via friendbot...',
  );
  const kp = Keypair.random();
  secret = kp.secret();

  try {
    const res = await fetch(
      `https://friendbot.stellar.org/?addr=${encodeURIComponent(kp.publicKey())}`,
    );
    if (!res.ok) {
      throw new Error(`Friendbot failed with status ${res.status}`);
    }
    await res.json();
    console.log(`[setup] Successfully funded ${kp.publicKey()} via Friendbot.`);
    fs.writeFileSync(keyPath, secret);
    console.log(`[setup] Saved secret to ${keyPath} for future runs.`);
    return secret;
  } catch (err) {
    console.error(`[setup] Failed to fund testnet account: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Helper to interact with the MCP CLI
 */
function createMcpClient(secret) {
  const cliPath = path.join(__dirname, '../../src/mcp/cli.js');
  const child = spawn(process.execPath, [cliPath], {
    env: {
      ...process.env,
      AGENT_PAYER_SECRET_KEY: secret,
      // Conservative limits for demonstration
      MAX_FEE_PER_CALL_STROOPS: '5000',
    },
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
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      } catch {
        // ignore parse errors for partial chunks
      }
    }
  });

  child.stderr.on('data', d => console.error(`[mcp stderr]`, d.toString().trim()));

  return {
    callTool: async (name, args) => {
      return new Promise((resolve, reject) => {
        const id = messageId++;
        pending.set(id, { resolve, reject });
        child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name, arguments: args },
          }) + '\n',
        );
      });
    },
    close: () => child.kill(),
  };
}

async function main() {
  const secret = await setupAgentAccount();
  const mcp = createMcpClient(secret);

  console.log('\n======================================================');
  console.log('🤖 AGENT WORKFLOW STARTING');
  console.log('======================================================\n');

  try {
    // 1. Discover
    console.log('Agent: "I need to find a tool to tell me a joke..."');
    console.log('-> calling search_resources({ query: "joke" })');

    const searchResult = await mcp.callTool('search_resources', { query: 'joke' });
    const resources = JSON.parse(searchResult.content[0].text).resources;

    if (!resources || resources.length === 0) {
      console.log(
        'Agent: "No joke endpoints found in the catalog. Make sure the HTTP seller example is running!"',
      );
      process.exit(1);
    }

    const jokeResource = resources[0];
    console.log(
      `\nAgent: "Found one! URL: ${jokeResource.url}. Price: ${jokeResource.pricing.amount} stroops."`,
    );

    // 2. Refusal Path (Spending cap too low)
    console.log('\nAgent: "Let me try calling it, but I will only authorize 50 stroops max."');
    console.log(
      `-> calling call_paid_resource({ url: "${jokeResource.url}", maxFeeStroops: "50" })`,
    );

    const refusalResult = await mcp.callTool('call_paid_resource', {
      url: jokeResource.url,
      maxFeeStroops: '50',
    });

    console.log(`\n[MCP PROXY RESPONSE]`);
    console.log(JSON.parse(refusalResult.content[0].text));

    // 3. Success Path
    console.log('\nAgent: "Ah, it refused me. Okay, I will authorize up to 5000 stroops."');
    console.log(
      `-> calling call_paid_resource({ url: "${jokeResource.url}", maxFeeStroops: "5000" })`,
    );

    const successResult = await mcp.callTool('call_paid_resource', {
      url: jokeResource.url,
      maxFeeStroops: '5000',
    });

    const content = JSON.parse(successResult.content[0].text);
    console.log(`\n[MCP PROXY RESPONSE]`);
    console.log(`Success: ${content.success}`);
    console.log(`Response Payload: ${content.response}`);
    console.log(
      `Settled Tx Hash: https://stellar.expert/explorer/testnet/tx/${content.settlement?.transaction}`,
    );
  } finally {
    mcp.close();
  }

  console.log('\n======================================================');
  console.log('🏁 AGENT WORKFLOW COMPLETE');
  console.log('======================================================\n');
}

main().catch(console.error);
