#!/usr/bin/env bash
# Deployment-boundary smoke test for the built bundle (dist/).
#
# Runs entirely against local processes: a tiny Bun HTTP server stands in
# for the IndexNow endpoint, so no external calls ever happen. Scenarios:
#   1. env-only configuration (INDEXNOW_SITES) boots and accepts submissions
#   2. a pending queue survives a process restart (and its site cooldown)
#   3. an old (schema v1) database upgrades in place on boot
#   4. a config file plus INDEXNOW_SITES fails fast instead of merging
#   5. a non-default PORT serves health probes
set -euo pipefail

DIST_DIR="$(cd "$(dirname "${1:-dist}")" && pwd)/$(basename "${1:-dist}")"
WORK="$(mktemp -d)"
# run from a scratch directory so an incidental relay.config.ts next to the
# repo cannot leak into the config-source decision
cd "$WORK"
PORT_ONE=3199
PORT_TWO=3212
STUB_PORT=3188
TOKEN=ci-token-0000000000001

SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  kill $(jobs -p) 2>/dev/null || true
}
trap cleanup EXIT

# Stand-in IndexNow endpoint: answer 503 to the first request (parking the
# submission in the queue with a site cooldown), 200 afterwards.
stub_state="$WORK/stub-state"
echo waiting > "$stub_state"
cat > "$WORK/stub.ts" <<EOF
import { readFileSync, writeFileSync } from 'node:fs'
const state = '$stub_state'
Bun.serve({
  port: $STUB_PORT,
  fetch() {
    const phase = readFileSync(state, 'utf8').trim()
    writeFileSync(state, 'answered')
    return phase === 'waiting'
      ? new Response('', { status: 503, headers: { 'retry-after': '120' } })
      : new Response('', { status: 200 })
  },
})
EOF
bun "$WORK/stub.ts" > "$WORK/stub.log" 2>&1 &

wait_for() {
  local url="$1" name="$2"
  for _ in $(seq 1 50); do
    if curl -fsS "$url" > /dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  echo "smoke: $name never became ready ($url)" >&2
  return 1
}

start_server() {
  local log="$1"
  shift
  bun "$DIST_DIR/server.js" > "$log" 2>&1 &
  SERVER_PID=$!
}

stop_server() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
}

export INDEXNOW_RELAY_TOKEN="$TOKEN"
export INDEXNOW_SITES='{"www.example.com":"a1b2c3d4e5f60718"}'
export INDEXNOW_ENDPOINT="http://127.0.0.1:$STUB_PORT/indexnow"
export INDEXNOW_RELAY_DB="$WORK/relay.db"
export PORT="$PORT_ONE"

echo "== 1/5 env-only configuration =="
INDEXNOW_RELAY_CONFIG="" start_server "$WORK/server1.log"
wait_for "http://127.0.0.1:$PORT_ONE/healthz" "env-config server"
curl -fsS -X POST "http://127.0.0.1:$PORT_ONE/v1/urls" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"urls":["https://www.example.com/ci-smoke"]}' | grep -q receiptId
# let the batch window pass so the stub's 503 actually happens and parks
# the URL behind a persisted site cooldown
for _ in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:$PORT_ONE/v1/admin/overview" \
      -H "Authorization: Bearer $TOKEN" | grep -q '"retryNotBefore":"2'; then
    break
  fi
  sleep 0.2
done
cooldown_before="$(curl -fsS "http://127.0.0.1:$PORT_ONE/v1/admin/overview" \
  -H "Authorization: Bearer $TOKEN" | grep -o '"retryNotBefore":"[^"]*"' | head -1)"
[ -n "$cooldown_before" ] || {
  echo "smoke: the 503 never produced a site cooldown" >&2
  exit 1
}
# Retry-After: 120 must win over the default backoff (~30-39s): the persisted
# deadline has to sit at least 110s out
cooldown_iso="$(printf '%s' "$cooldown_before" | sed 's/.*:"//;s/"$//')"
cooldown_epoch="$(bun -e 'console.log(Date.parse(process.argv[1]!))' "$cooldown_iso")"
now_epoch="$(bun -e 'console.log(Date.now())')"
[ "$((cooldown_epoch - now_epoch))" -ge 110000 ] || {
  echo "smoke: cooldown does not reflect Retry-After: 120 ($cooldown_before)" >&2
  exit 1
}

echo "== 2/5 pending queue and site cooldown survive a restart =="
stop_server
sleep 0.5
start_server "$WORK/server2.log"
wait_for "http://127.0.0.1:$PORT_ONE/healthz" "restarted server"
# the URL is still queued behind the same persisted cooldown
curl -fsS "http://127.0.0.1:$PORT_ONE/v1/admin/queue?site=www.example.com" \
  -H "Authorization: Bearer $TOKEN" | grep -q 'ci-smoke'
cooldown_after="$(curl -fsS "http://127.0.0.1:$PORT_ONE/v1/admin/overview" \
  -H "Authorization: Bearer $TOKEN" | grep -o '"retryNotBefore":"[^"]*"')"
[ "$cooldown_before" = "$cooldown_after" ] || {
  echo "smoke: cooldown changed across restart ($cooldown_before -> $cooldown_after)" >&2
  exit 1
}
stop_server

echo "== 3/5 old database upgrades in place =="
cat > "$WORK/make-v1.ts" <<'EOF'
import { Database } from 'bun:sqlite'
// schema v1 as shipped in the first release: no revision / not_before_at /
// retry_not_before_at columns, migration bookkeeping at version 1
const db = new Database(process.argv[2]!)
db.exec(`CREATE TABLE receipts (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, received INTEGER NOT NULL, enqueued INTEGER NOT NULL, coalesced INTEGER NOT NULL, sites TEXT NOT NULL)`)
db.exec(`CREATE TABLE pending_urls (site_host TEXT NOT NULL, url TEXT NOT NULL, event_type TEXT, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lease_id TEXT, lease_until INTEGER, last_receipt_id TEXT, last_error TEXT, status TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY (site_host, url)) WITHOUT ROWID`)
db.exec(`CREATE INDEX idx_pending_urls_due ON pending_urls (due_at) WHERE status = 'pending' AND lease_id IS NULL`)
db.exec(`CREATE TABLE submission_state (site_host TEXT NOT NULL, url TEXT NOT NULL, sent_at INTEGER NOT NULL, PRIMARY KEY (site_host, url)) WITHOUT ROWID`)
db.exec(`CREATE TABLE submission_batches (id TEXT PRIMARY KEY, site_host TEXT NOT NULL, status TEXT NOT NULL, url_count INTEGER NOT NULL, attempt INTEGER NOT NULL, created_at INTEGER NOT NULL, completed_at INTEGER, retry_at INTEGER, http_status INTEGER, error_code TEXT, error_message TEXT)`)
db.exec(`CREATE INDEX idx_submission_batches_site ON submission_batches (site_host, created_at DESC)`)
db.exec(`CREATE TABLE site_state (site_host TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0, paused_at INTEGER, paused_reason TEXT, updated_at INTEGER NOT NULL)`)
db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`)
db.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, \'init\', 0)').run()
// due far in the future so it stays queued after the upgrade
db.query(`INSERT INTO pending_urls (site_host, url, first_seen_at, last_seen_at, due_at, status) VALUES ('www.example.com', 'https://www.example.com/from-v1', ?, ?, ?, 'pending')`).run(Date.now() - 1000, Date.now(), Date.now() + 3_600_000)
db.close()
EOF
export INDEXNOW_RELAY_DB="$WORK/v1.db"
bun "$WORK/make-v1.ts" "$WORK/v1.db"
start_server "$WORK/server3.log"
wait_for "http://127.0.0.1:$PORT_ONE/readyz" "upgraded-db server"
# the v1 row survived the upgrade and is still queued
curl -fsS "http://127.0.0.1:$PORT_ONE/v1/admin/queue?site=www.example.com" \
  -H "Authorization: Bearer $TOKEN" | grep -q 'from-v1'
stop_server

echo "== 4/5 config file plus INDEXNOW_SITES fails fast =="
cat > "$WORK/relay.config.ts" <<EOF
import { defineConfig, env } from '$DIST_DIR/config/index.js'
export default defineConfig({
  auth: env('INDEXNOW_RELAY_TOKEN'),
  sites: { 'www.example.com': env('INDEXNOW_KEY_WWW_EXAMPLE_COM', 'a1b2c3d4e5f60718') },
})
EOF
export INDEXNOW_RELAY_CONFIG="$WORK/relay.config.ts"
# startup must fail fast instead of serving: run with a watchdog so a
# regression (both sources accepted) fails the scenario instead of hanging
set +e
PORT="$PORT_ONE" bun "$DIST_DIR/server.js" > "$WORK/conflict.log" 2>&1 &
CONFLICT_PID=$!
SERVER_PID="$CONFLICT_PID"
for _ in $(seq 1 50); do
  kill -0 "$CONFLICT_PID" 2>/dev/null || break
  sleep 0.2
done
if kill -0 "$CONFLICT_PID" 2>/dev/null; then
  echo "smoke: conflicting config sources must fail fast (server kept running)" >&2
  exit 1
fi
wait "$CONFLICT_PID"
CONFLICT_EXIT=$?
set -e
[ "$CONFLICT_EXIT" -ne 0 ] || {
  echo "smoke: conflicting config sources exited 0" >&2
  exit 1
}
grep -qi 'INDEXNOW_SITES' "$WORK/conflict.log" || {
  echo "smoke: conflict error did not name the two sources" >&2
  exit 1
}
SERVER_PID=""
unset INDEXNOW_RELAY_CONFIG
rm -f "$WORK/relay.config.ts"

echo "== 5/5 non-default port =="
export INDEXNOW_RELAY_DB="$WORK/relay2.db"
PORT="$PORT_TWO" start_server "$WORK/server4.log"
wait_for "http://127.0.0.1:$PORT_TWO/healthz" "alt-port server"
curl -fsS "http://127.0.0.1:$PORT_TWO/readyz" > /dev/null

echo "smoke: all deployment-boundary scenarios passed"
