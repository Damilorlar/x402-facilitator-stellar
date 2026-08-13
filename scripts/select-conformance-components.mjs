#!/usr/bin/env node
/**
 * Decides which upstream e2e components the conformance run should exercise.
 *
 * WHY THIS EXISTS. `e2e/setup.sh` in x402-foundation/x402 installs and builds
 * *every* component in the harness — fifteen of them, across TypeScript, Go and
 * Python — and exits non-zero if any one fails. On 2026-08-12 that killed our
 * conformance job before it ran a single scenario, because
 * `server/typescript/http/next` failed to build. Next.js is not on the Stellar
 * payment path we are being judged on, and it is not our code.
 *
 * The wrong fixes are both easy to reach for:
 *
 *   - `./setup.sh || true` — hides a build failure in a component we *do*
 *     depend on, and the run then fails later with something less legible.
 *   - a hardcoded `--servers=typescript/http/express` — freezes the matrix at
 *     whatever upstream looked like the day it was written, and quietly stops
 *     testing new server implementations as they are added.
 *
 * So instead: discover the components the way the harness discovers them,
 * subtract the ones whose build actually failed, and report the subtraction
 * loudly. A component is dropped only with a named reason, and dropping the
 * last server or the last client is a hard error rather than a green run of
 * nothing.
 *
 * Discovery deliberately mirrors `e2e/src/component.ts`: names are the
 * role-relative path (`typescript/http/express`, `typescript/mcp`), because
 * that is what `--servers=` / `--clients=` match against. The SDK languages are
 * read from the Stellar mechanisms file rather than assumed, so that the day
 * upstream adds a Go SDK for the exact/stellar route, this picks it up.
 *
 * Usage:
 *   node scripts/select-conformance-components.mjs \
 *     --e2e-dir=/path/to/x402/e2e \
 *     --setup-log=/path/to/setup-output.txt \
 *     [--family=stellar] [--github-output]
 */
import { existsSync, readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const e2eDir = arg('e2e-dir');
const setupLog = arg('setup-log');
const family = arg('family', 'stellar');
const toGithubOutput = args.includes('--github-output');

if (!e2eDir) {
  console.error('--e2e-dir is required');
  process.exit(2);
}

// Mirrors component.ts: these are infrastructure, not components.
const SKIP = new Set([
  'shared',
  'node_modules',
  'external-proxies',
  'local',
  '.venv',
  '__pycache__',
  '.next',
]);
const TRANSPORTS = ['http', 'mcp'];

/** The languages the mechanisms file says can serve this family's routes. */
function sdkLanguages() {
  const path = join(e2eDir, 'config', `mechanisms_${family}.json`);
  if (!existsSync(path)) {
    throw new Error(`no mechanisms file for family "${family}" at ${path}`);
  }
  const mechanisms = JSON.parse(readFileSync(path, 'utf8'));
  const languages = new Set();
  for (const route of Object.values(mechanisms.routes ?? {})) {
    for (const sdk of route.sdks ?? []) {
      languages.add(sdk);
    }
  }
  if (languages.size === 0) {
    throw new Error(`mechanisms_${family}.json declares no route SDKs`);
  }
  return [...languages];
}

/** Mirrors isComponentDir() in e2e/src/component.ts. */
function isComponent(dir) {
  return ['test.config.json', 'index.ts', 'main.go', 'main.py', 'package.json'].some(f =>
    existsSync(join(dir, f)),
  );
}

/** Discover component names under servers/ or clients/, as the harness names them. */
function discover(role, languages) {
  const roleDir = join(e2eDir, role);
  if (!existsSync(roleDir)) return [];

  const found = [];
  for (const language of languages) {
    const languageDir = join(roleDir, language);
    if (!existsSync(languageDir)) continue;

    for (const transport of TRANSPORTS) {
      const transportDir = join(languageDir, transport);
      if (!existsSync(transportDir)) continue;

      // mcp is itself the component; http holds one directory per component.
      if (transport === 'mcp') {
        if (isComponent(transportDir)) {
          found.push(relative(roleDir, transportDir).split(/[/\\]/).join('/'));
        }
        continue;
      }

      for (const entry of readdirSync(transportDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
        const dir = join(transportDir, entry.name);
        if (isComponent(dir)) {
          found.push(relative(roleDir, dir).split(/[/\\]/).join('/'));
        }
      }
    }
  }
  return found.sort();
}

/**
 * Components setup.sh reported as failed, as `{ role, name }`.
 *
 * setup.sh prints them under an "❌ FAILED COMPONENTS:" heading, one per line,
 * as `   • server/typescript/http/next` — role prefix, then the harness name.
 */
function failedComponents() {
  if (!setupLog || !existsSync(setupLog)) return [];

  const lines = readFileSync(setupLog, 'utf8').split('\n');
  const start = lines.findIndex(l => l.includes('FAILED COMPONENTS'));
  if (start === -1) return [];

  const failed = [];
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^\s*•\s*(server|client|facilitator)\/(.+?)\s*$/);
    if (!match) {
      // The list is contiguous; the first non-bullet line after it ends it.
      if (line.trim() === '') continue;
      break;
    }
    failed.push({ role: match[1], name: match[2] });
  }
  return failed;
}

const languages = sdkLanguages();
const failed = failedComponents();
const failedFor = role => new Set(failed.filter(f => f.role === role).map(f => f.name));

const report = { servers: {}, clients: {} };
for (const [role, key] of [
  ['servers', 'servers'],
  ['clients', 'clients'],
]) {
  const singular = role.slice(0, -1);
  const discovered = discover(role, languages);
  const broken = failedFor(singular);
  report[key] = {
    discovered,
    excluded: discovered.filter(n => broken.has(n)),
    selected: discovered.filter(n => !broken.has(n)),
  };
}

// A facilitator that failed to build is a different matter: ours is the one
// under test, so its failure is fatal rather than something to route around.
const facilitatorFailures = failed.filter(f => f.role === 'facilitator');

console.log(`family: ${family}`);
console.log(`sdk languages (from mechanisms_${family}.json): ${languages.join(', ')}`);
for (const role of ['servers', 'clients']) {
  const r = report[role];
  console.log(`${role}: ${r.selected.length}/${r.discovered.length} selected`);
  for (const name of r.discovered) {
    console.log(`  ${r.excluded.includes(name) ? '✗ (build failed)' : '✓'} ${name}`);
  }
}
if (facilitatorFailures.length > 0) {
  console.log(`facilitator build failures: ${facilitatorFailures.map(f => f.name).join(', ')}`);
}

const excluded = [...report.servers.excluded, ...report.clients.excluded];

// Refuse to report a green run that proved nothing. If every server or every
// client is gone, there is no scenario left to exercise and the honest outcome
// is a failure that says so.
const fatal = [];
if (report.servers.selected.length === 0) {
  fatal.push('every discovered server failed to build — no scenario can run');
}
if (report.clients.selected.length === 0) {
  fatal.push('every discovered client failed to build — no scenario can run');
}
if (facilitatorFailures.length > 0) {
  fatal.push(
    `facilitator components failed to build: ${facilitatorFailures.map(f => f.name).join(', ')}`,
  );
}

if (toGithubOutput && process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `servers=${report.servers.selected.join(',')}`,
      `clients=${report.clients.selected.join(',')}`,
      `excluded=${excluded.join(',')}`,
      `excluded_count=${excluded.length}`,
      '',
    ].join('\n'),
  );
}

if (fatal.length > 0) {
  for (const reason of fatal) {
    console.error(`::error::${reason}`);
  }
  process.exit(1);
}
