// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Human-readable summary of a chain-protocol message
//
// Translates the decoded payload of a `remote_chain_*` TrUAPI message
// into a single-sentence description. Used in the detail pane so a
// reader doesn't have to parse the JSON to understand what a message
// is doing.
//
// Returns `null` for non-chain messages or unknown shapes. The caller
// omits the summary section when null.

import type { ChainAnnotations } from "./chain-decode.ts";
import { formatChainDisplay } from "./chain-registry.ts";

/** Length at which we abbreviate hex strings in the human summary. */
const HEX_SHORT_LEN = 8;

export function summariseChainMessage(
  ann: ChainAnnotations,
  payload: unknown,
): string | null {
  const inner = peelVersion(payload);

  switch (ann.kind) {
    case "follow-start": {
      const p = asObj(inner);
      const withRuntime = p?.withRuntime === true;
      return `Subscribe to chain head${withRuntime ? " (with runtime)" : ""}${fmtChain(ann.genesisHash)}.`;
    }
    case "follow-receive":
      return summariseFollowEvent(inner);
    case "head-header-request":
      return `Fetch header of block ${fmtBlock(ann.blockHash)}${fmtFollowSub(ann.followSubscriptionId)}.`;
    case "head-header-response":
      return summariseHeaderResponse(ann, inner);
    case "head-body-request":
      return `Fetch body of block ${fmtBlock(ann.blockHash)}${fmtFollowSub(ann.followSubscriptionId)}.`;
    case "head-body-response":
      return summariseOperationStarter(ann, "Body fetch");
    case "head-storage-request":
      return summariseStorageRequest(ann, inner);
    case "head-storage-response":
      return summariseOperationStarter(ann, "Storage query");
    case "head-call-request":
      return summariseCallRequest(ann, inner);
    case "head-call-response":
      return summariseOperationStarter(ann, "Runtime call");
    case "head-unpin-request": {
      const p = asObj(inner);
      const hashes = Array.isArray(p?.hashes) ? p.hashes : [];
      return `Release ${String(hashes.length)} pinned block${hashes.length === 1 ? "" : "s"}${fmtFollowSub(ann.followSubscriptionId)}.`;
    }
    case "head-unpin-response":
      return summariseSimpleResponse(ann, "Unpin");
    case "head-continue-request":
      return `Continue paused storage operation ${shortId(ann.operationId)}${fmtFollowSub(ann.followSubscriptionId)}.`;
    case "head-continue-response":
      return summariseSimpleResponse(ann, "Continue");
    case "head-stop-op-request":
      return `Abort operation ${shortId(ann.operationId)}${fmtFollowSub(ann.followSubscriptionId)}.`;
    case "head-stop-op-response":
      return summariseSimpleResponse(ann, "Stop operation");
    case "spec-genesis-hash-request":
      return `Look up genesis hash${fmtChain(ann.genesisHash)}.`;
    case "spec-genesis-hash-response":
      return summariseStringResponse(ann, inner, "Genesis hash");
    case "spec-chain-name-request":
      return `Look up chain name${fmtChain(ann.genesisHash)}.`;
    case "spec-chain-name-response":
      return summariseStringResponse(ann, inner, "Chain name");
    case "spec-properties-request":
      return `Look up chain properties${fmtChain(ann.genesisHash)}.`;
    case "spec-properties-response":
      return summariseStringResponse(ann, inner, "Properties");
    case "tx-broadcast-request": {
      const p = asObj(inner);
      const tx = asString(p?.transaction);
      const bytes = tx === undefined ? null : hexByteLen(tx);
      return `Broadcast transaction${bytes === null ? "" : ` (${String(bytes)} bytes)`}${fmtChain(ann.genesisHash)}.`;
    }
    case "tx-broadcast-response":
      if (ann.outcome === "started") {
        return `Broadcast accepted. Tracking id: ${ann.operationId ?? "?"}.`;
      }
      if (ann.outcome === "limit-reached") {
        return "Broadcast rejected: node at capacity.";
      }
      if (ann.outcome === "error") {
        return `Broadcast error: ${ann.errorMessage ?? "unknown"}.`;
      }
      return null;
    case "tx-stop-request":
      return `Stop broadcasting transaction ${shortId(ann.operationId)}${fmtChain(ann.genesisHash)}.`;
    case "tx-stop-response":
      return summariseSimpleResponse(ann, "Stop broadcast");
  }
}

function summariseFollowEvent(inner: unknown): string | null {
  const ev = asEnum(inner);
  if (ev === undefined) {
    return null;
  }
  const v = asObj(ev.value);
  switch (ev.tag) {
    case "Initialized": {
      const hashes = Array.isArray(v?.finalizedBlockHashes)
        ? v.finalizedBlockHashes
        : [];
      return `Initialised with ${String(hashes.length)} finalized block${hashes.length === 1 ? "" : "s"}.`;
    }
    case "NewBlock": {
      const block = asString(v?.blockHash);
      const parent = asString(v?.parentBlockHash);
      return `New block ${fmtBlock(block)} (parent ${fmtBlock(parent)}).`;
    }
    case "BestBlockChanged": {
      const block = asString(v?.bestBlockHash);
      return `Best block now ${fmtBlock(block)}.`;
    }
    case "Finalized": {
      const fin = Array.isArray(v?.finalizedBlockHashes)
        ? v.finalizedBlockHashes
        : [];
      const pruned = Array.isArray(v?.prunedBlockHashes)
        ? v.prunedBlockHashes
        : [];
      return `Finalized ${String(fin.length)} block${fin.length === 1 ? "" : "s"}, pruned ${String(pruned.length)}.`;
    }
    case "OperationBodyDone": {
      const extrinsics = Array.isArray(v?.value) ? v.value : [];
      return `Body returned: ${String(extrinsics.length)} extrinsic${extrinsics.length === 1 ? "" : "s"} (op ${shortId(asString(v?.operationId))}).`;
    }
    case "OperationCallDone":
      return `Runtime call result ready (op ${shortId(asString(v?.operationId))}).`;
    case "OperationStorageItems": {
      const items = Array.isArray(v?.items) ? v.items : [];
      return `Storage batch: ${String(items.length)} item${items.length === 1 ? "" : "s"} (op ${shortId(asString(v?.operationId))}).`;
    }
    case "OperationStorageDone":
      return `Storage operation complete (op ${shortId(asString(v?.operationId))}).`;
    case "OperationWaitingForContinue":
      return `Paused — client must call chainHead.continue (op ${shortId(asString(v?.operationId))}).`;
    case "OperationInaccessible":
      return `Block unavailable, retry (op ${shortId(asString(v?.operationId))}).`;
    case "OperationError": {
      const err = asString(v?.error);
      return `Operation failed: ${err ?? "unknown"} (op ${shortId(asString(v?.operationId))}).`;
    }
    case "Stop":
      return "Subscription stopped by the server — client must create a new follow.";
  }
  return null;
}

function summariseStorageRequest(
  ann: ChainAnnotations,
  inner: unknown,
): string {
  const p = asObj(inner);
  const items = Array.isArray(p?.items) ? p.items : [];
  const types = new Set<string>();
  for (const it of items) {
    const t = asString(asObj(it)?.type);
    if (t !== undefined) {
      types.add(t);
    }
  }
  const typeSuffix =
    types.size === 0 ? "" : ` (${Array.from(types).join(", ")})`;
  return `Query ${String(items.length)} storage item${items.length === 1 ? "" : "s"}${typeSuffix} on block ${fmtBlock(ann.blockHash)}${fmtFollowSub(ann.followSubscriptionId)}.`;
}

function summariseCallRequest(ann: ChainAnnotations, inner: unknown): string {
  const p = asObj(inner);
  const fn = asString(p?.function);
  return `Invoke runtime api ${fn ?? "?"} on block ${fmtBlock(ann.blockHash)}${fmtFollowSub(ann.followSubscriptionId)}.`;
}

function summariseHeaderResponse(
  ann: ChainAnnotations,
  inner: unknown,
): string | null {
  if (ann.outcome === "error") {
    return `Header fetch failed: ${ann.errorMessage ?? "unknown"}.`;
  }
  const r = asObj(inner);
  const value = r?.value;
  if (value === null) {
    return "Block not found (header null).";
  }
  const bytes = hexByteLen(asString(value) ?? "");
  const bytesLabel = bytes === null ? "?" : String(bytes);
  return `Header returned (${bytesLabel} bytes).`;
}

function summariseOperationStarter(
  ann: ChainAnnotations,
  label: string,
): string | null {
  if (ann.outcome === "started") {
    return `${label} accepted. Operation id: ${ann.operationId ?? "?"}. Result will stream through the follow subscription.`;
  }
  if (ann.outcome === "limit-reached") {
    return `${label} rejected: node at capacity.`;
  }
  if (ann.outcome === "error") {
    return `${label} rejected: ${ann.errorMessage ?? "unknown"}.`;
  }
  return null;
}

function summariseSimpleResponse(
  ann: ChainAnnotations,
  label: string,
): string | null {
  if (ann.outcome === "ok") {
    return `${label} acknowledged.`;
  }
  if (ann.outcome === "error") {
    return `${label} failed: ${ann.errorMessage ?? "unknown"}.`;
  }
  return null;
}

function summariseStringResponse(
  ann: ChainAnnotations,
  inner: unknown,
  label: string,
): string | null {
  if (ann.outcome === "error") {
    return `${label} lookup failed: ${ann.errorMessage ?? "unknown"}.`;
  }
  const r = asObj(inner);
  const value = asString(r?.value);
  if (value === undefined) {
    return `${label} lookup returned.`;
  }
  return `${label}: ${value}.`;
}

function peelVersion(v: unknown): unknown {
  const o = asObj(v);
  if (o === undefined) {
    return v;
  }
  if (typeof o.tag === "string" && /^v\d+$/.test(o.tag) && "value" in o) {
    return o.value;
  }
  return v;
}

function asObj(v: unknown): Record<string, unknown> | undefined {
  if (typeof v === "object" && v !== null) {
    return v as Record<string, unknown>;
  }
  return undefined;
}

function asEnum(v: unknown): { tag: string; value: unknown } | undefined {
  const o = asObj(v);
  if (o === undefined) {
    return undefined;
  }
  if (typeof o.tag !== "string") {
    return undefined;
  }
  return { tag: o.tag, value: o.value };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function fmtBlock(hash: string | undefined): string {
  return hash === undefined ? "?" : shortHash(hash);
}

function fmtChain(hash: string | undefined): string {
  return hash === undefined ? "" : ` on ${formatChainDisplay(hash)}`;
}

function fmtFollowSub(sub: string | undefined): string {
  return sub === undefined ? "" : ` (sub ${sub})`;
}

function shortHash(v: string): string {
  if (v.startsWith("0x") && v.length > HEX_SHORT_LEN + 4) {
    return `${v.slice(0, HEX_SHORT_LEN)}…${v.slice(-4)}`;
  }
  return v;
}

function shortId(v: string | undefined): string {
  if (v === undefined) {
    return "?";
  }
  if (v.length > 10) {
    return `${v.slice(0, 8)}…`;
  }
  return v;
}

function hexByteLen(hex: string): number | null {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length % 2 !== 0) {
    return null;
  }
  return body.length / 2;
}
