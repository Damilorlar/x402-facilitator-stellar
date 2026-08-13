#!/usr/bin/env bash
#
# Launches this facilitator under the upstream x402 e2e harness.
#
# The harness spawns a facilitator component from its own directory, waits for
# the literal string "Facilitator listening" on stdout, then health-checks the
# endpoint declared in test.config.json. Neither matches what this service does
# on its own:
#
#   - our boot banner reads "x402 Stellar facilitator listening on :PORT", and
#     the harness's match is case-sensitive, so the lowercase "f" misses;
#   - our liveness route is /healthz, not the harness default /health, which
#     test.config.json declares rather than us renaming the route to suit a
#     test harness.
#
# So this waits for the service to actually answer and then emits the line the
# harness is waiting for. It deliberately does NOT proxy or rewrite anything:
# the harness talks straight to our HTTP surface on $PORT, so what it exercises
# is the real wire format and not an adapter's idea of it. An adapter that
# reshaped requests would make the whole exercise worthless.
#
set -euo pipefail

REPO_DIR="${ACCENSA_FACILITATOR_DIR:?ACCENSA_FACILITATOR_DIR must point at the facilitator checkout}"
PORT="${PORT:?PORT is set by the harness}"
: "${FACILITATOR_SECRET:?FACILITATOR_SECRET must be a funded testnet S... key}"

cd "$REPO_DIR"

node src/server.js &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM

# Poll rather than sleep. A fixed sleep is either too short on a cold runner or
# wasted time on a warm one, and a facilitator that failed to boot should be
# reported as such rather than as a timeout thirty seconds later.
for _ in $(seq 1 60); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "facilitator exited during startup" >&2
    wait "$SERVER_PID"
    exit 1
  fi
  if curl -4 -fsS --max-time 2 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    # The exact string src/proxy-base.ts waits for.
    echo "Facilitator listening on :${PORT}"
    wait "$SERVER_PID"
    exit $?
  fi
  sleep 0.5
done

echo "facilitator did not answer /healthz on :${PORT} within 30s" >&2
exit 1
