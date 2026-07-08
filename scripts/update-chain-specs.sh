#!/usr/bin/env bash
# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: AGPL-3.0-only

# Refresh the committed smoldot chain specs from their live chains.
#
# Each spec's genesis.stateRootHash is set from the chain's block 0, so the spec keeps matching the
# chain's genesis after a wipe; a stale genesis stops smoldot from syncing. Relay specs additionally
# get a fresh lightSyncState checkpoint, which reduces smoldot sync time from ~12s to ~1-3s.
#
# Usage: bash scripts/update-chain-specs.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SPECS_DIR="$PROJECT_DIR/packages/resolver/src/chain-specs"

# Timeout (seconds) for all curl calls.
TIMEOUT=30

# Health-check the candidate bootNodes (env var BOOTNODES) and keep only the reachable ones.
# Set env var SKIP_BOOTNODE_CHECK=true to leave them unchanged.
BOOTNODES_JS='
const fs = require("fs");
const net = require("net");

const skipBootnodeCheck = process.env.SKIP_BOOTNODE_CHECK === "true";

function parseMultiaddr(ma) {
  const parts = ma.split("/").filter(Boolean);
  let host = null, port = null;
  for (let i = 0; i < parts.length; i++) {
    if (["dns", "dns4", "dns6"].includes(parts[i]) && parts[i + 1]) {
      host = parts[i + 1];
    } else if (parts[i] === "ip4" && parts[i + 1]) {
      host = parts[i + 1];
    } else if (parts[i] === "tcp" && parts[i + 1]) {
      port = parseInt(parts[i + 1], 10);
    }
  }
  return { host, port };
}

function testBootnode(ma, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const { host, port } = parseMultiaddr(ma);
    if (!host || !port) {
      resolve({ ma, healthy: false, reason: "unparseable" });
      return;
    }
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    socket.on("connect", () => {
      socket.destroy();
      resolve({ ma, healthy: true });
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ ma, healthy: false, reason: "timeout" });
    });
    socket.on("error", (err) => {
      socket.destroy();
      resolve({ ma, healthy: false, reason: err.code || err.message });
    });
  });
}

(async () => {
  const specPath = process.argv[1];
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

  if (skipBootnodeCheck) {
    console.log("  Bootnode health check SKIPPED, keeping existing bootnodes.");
    console.log("  Bootnodes (unchanged): " + spec.bootNodes.length);
    return;
  }

  const candidates = JSON.parse(process.env.BOOTNODES);
  console.log("  Testing " + candidates.length + " bootnodes (5s timeout each)...");
  const results = await Promise.all(candidates.map((bn) => testBootnode(bn)));
  const healthy = [];
  for (const r of results) {
    const short = r.ma.length > 80 ? r.ma.substring(0, 77) + "..." : r.ma;
    if (r.healthy) {
      console.log("    ✓ " + short);
      healthy.push(r.ma);
    } else {
      console.log("    ✗ " + short + " (" + r.reason + ")");
    }
  }
  console.log("  Healthy: " + healthy.length + "/" + candidates.length);
  if (healthy.length === 0) {
    console.log("  WARNING: No healthy bootnodes found, keeping original.");
  } else {
    spec.bootNodes = healthy;
    fs.writeFileSync(specPath, JSON.stringify(spec));
  }
  console.log("  Bootnodes: " + spec.bootNodes.length);
})();
'

# Fetch the genesis state root.
fetch_state_root() {
  local rpc="$1"
  local block0
  block0=$(curl -s --max-time "$TIMEOUT" -H "Content-Type: application/json" \
    -d '{"id":1,"jsonrpc":"2.0","method":"chain_getBlockHash","params":[0]}' "$rpc" 2>/dev/null \
    | jq -r '.result // empty' 2>/dev/null)
  [ -z "$block0" ] && return 1
  curl -s --max-time "$TIMEOUT" -H "Content-Type: application/json" \
    -d "{\"id\":1,\"jsonrpc\":\"2.0\",\"method\":\"chain_getHeader\",\"params\":[\"$block0\"]}" "$rpc" 2>/dev/null \
    | jq -r '.result.stateRoot // empty' 2>/dev/null
}

# Refresh a spec from its live chain.
#
# Always sets genesis.stateRootHash from the chain's block 0, so the spec keeps matching the chain's
# genesis after a wipe. smoldot derives the block-announces protocol name from the genesis hash, so
# a stale genesis yields a name no peer offers, the substream fails with ProtocolNotAvailable, and
# smoldot can't sync the chain. sync_state_genSyncSpec is not used for the genesis, as it returns a
# genesis that serializes extra storage keys, so its computed hash does not match the real block 0.
#
# For a relay it also fetches sync_state_genSyncSpec and writes a fresh lightSyncState checkpoint
# for smoldot to warp-sync from (a relay has no parent to follow). A parachain follows its relay
# instead, so any committed lightSyncState is dropped. If that response carries bootNodes, they are
# health-checked and pruned to the reachable ones; otherwise existing bootNodes are preserved.
#
# Pass one or more RPC URLs; the first that serves block 0 is used.
refresh_spec() {
  local spec_file="$1"
  local is_relay="$2"
  shift 2

  echo "Refreshing $spec_file..."

  local fields="" rpc="" state_root=""
  for candidate in "$@"; do
    state_root=$(fetch_state_root "$candidate") || true
    if [ -n "$state_root" ]; then
      rpc="$candidate"
      break
    fi
    echo "  No block 0 from $candidate"
  done
  if [ -z "$state_root" ]; then
    echo "  ERROR: Could not fetch genesis state root for $spec_file from any RPC."
    return 1
  fi
  fields+="genesis.stateRootHash"

  # Relays read sync_state_genSyncSpec for their checkpoint; the same response also carries the
  # bootNodes. Pull only those two fields; jq drops the multi-MB genesis the response also returns.
  local light_sync_state="null" bootnodes="[]"
  if [ "$is_relay" = "true" ]; then
    local fresh
    fresh=$(curl -s --max-time "$TIMEOUT" -H "Content-Type: application/json" \
      -d '{"id":1,"jsonrpc":"2.0","method":"sync_state_genSyncSpec","params":[true]}' "$rpc" 2>/dev/null \
      | jq -c '{lightSyncState: .result.lightSyncState, bootNodes: .result.bootNodes}' 2>/dev/null || echo "null")
    light_sync_state=$(echo "$fresh" | jq -c '.lightSyncState // null')
    bootnodes=$(echo "$fresh" | jq -c '.bootNodes // []')
    # Without lightSyncState, smoldot can't sync a relay from a stateRootHash-only genesis, so fail.
    if [ "$light_sync_state" = "null" ]; then
      echo "  ERROR: Could not fetch lightSyncState from $rpc."
      return 1
    fi
    fields+=" + lightSyncState"
  fi

  # lightSyncState can be hundreds of KB, so it goes via stdin; the small state root goes via env.
  echo "$light_sync_state" | STATE_ROOT="$state_root" \
    bun -e '
      const fs = require("fs");
      let stdin = "";
      process.stdin.on("data", (chunk) => stdin += chunk);
      process.stdin.on("end", () => {
        const specPath = process.argv[1];
        const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
        spec.genesis = { stateRootHash: process.env.STATE_ROOT };
        const lss = JSON.parse(stdin);
        if (lss) spec.lightSyncState = lss;
        else delete spec.lightSyncState;
        fs.writeFileSync(specPath, JSON.stringify(spec));
      });
    ' "$SPECS_DIR/$spec_file"

  # Health-check bootNodes only when the chain actually advertises some.
  if [ "$(echo "$bootnodes" | jq 'length')" -gt 0 ]; then
    BOOTNODES="$bootnodes" bun -e "$BOOTNODES_JS" "$SPECS_DIR/$spec_file"
    fields+=" + bootNodes"
  fi

  echo "  Updated $spec_file: $fields"
  echo ""
}

# Previewnet
refresh_spec "previewnet.smol.json"                true  "https://previewnet.substrate.dev/relay/alice"
refresh_spec "previewnet-asset-hub.smol.json"      false "https://previewnet.substrate.dev/asset-hub"
refresh_spec "previewnet-bulletin-local.smol.json" false "https://previewnet.substrate.dev/bulletin"
refresh_spec "previewnet-people.smol.json"         false "https://previewnet.substrate.dev/people"

# Paseo Next v2
refresh_spec "paseo.smol.json"                     true  "https://paseo-rpc.n.dwellir.com" \
                                                         "https://rpc.interweb-it.com/paseo" \
                                                         "https://rpc-paseo.stakeworld.io"
refresh_spec "paseo-asset-hub-next.smol.json"      false "https://paseo-asset-hub-next-rpc.polkadot.io"
refresh_spec "paseo-bulletin-next.smol.json"       false "https://paseo-bulletin-next-rpc.polkadot.io"
refresh_spec "paseo-people-next-system.smol.json"  false "https://paseo-people-next-system-rpc.polkadot.io"

echo "Done. Chain specs updated in packages/resolver/src/chain-specs/"
echo "Rebuild the app to use the new specs."
