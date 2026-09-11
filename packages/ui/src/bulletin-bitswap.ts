// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { isResponse } from "@polkadot-api/json-rpc-provider";
import type {
  JsonRpcConnection,
  JsonRpcMessage,
} from "@polkadot-api/json-rpc-provider";
import { hexToBytes } from "@noble/hashes/utils.js";
import {
  createRemoteChainProvider,
  isRemoteChainSupported,
} from "@dotli/protocol/client";
import { isSandboxOrigin } from "@dotli/config/config";
import { getBackend } from "@dotli/config/mode";
import { getActiveServicesConfig } from "@dotli/config/network";
import { log } from "@dotli/shared/log";
import { serializeError } from "@dotli/shared/errors";

// JSON-RPC error codes returned by `bitswap_v1_get`. RETRY and BACKOFF are
// transient and retryable. INVALID_PARAMS is terminal.
const ERR_INVALID_PARAMS = -32602;
const ERR_FAIL = -32810;
const ERR_FAIL_RETRY = -32811;
const ERR_FAIL_BACKOFF = -32812;

const PER_CALL_TIMEOUT_MS = 60_000;
const TOTAL_BUDGET_MS = 180_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 5_000;

// -32810 reads like a terminal "not found", but smoldot means something much
// narrower by it. `light-base/src/bitswap_service.rs` freezes the set of peers
// connected at the instant of the call, broadcasts a "have" request to exactly
// those, and fails the request the moment every one of them has answered
// DONT_HAVE. Peers that connect afterwards are never added to that set, and
// there is no DHT provider lookup to fall back on.
//
// So on a fresh page the snapshot is whatever handful of Bulletin peers
// happened to be up, and whether one of them holds the CID is luck. Retrying
// takes a new, larger snapshot. Observed live: reloads that gave up on the
// first -32810 died at ~1.2s, while reloads that kept asking got the same CID
// 3 to 15 seconds later.
//
// Discovery gets its own wall-clock window rather than the full budget: a CID
// that genuinely is not on the network should fail in seconds, not in three
// minutes. The window is a wall-clock bound rather than a retry count so that
// it stays meaningful if the backoff schedule is ever retuned.
const DISCOVERY_BUDGET_MS = 30_000;

interface PendingResolver {
  resolve: (bytes: Uint8Array) => void;
  reject: (err: Error) => void;
}

let nextId = 1;
const pending = new Map<number, PendingResolver>();

let connection: JsonRpcConnection | null = null;

function ensureConnection(): JsonRpcConnection {
  if (connection !== null) {
    return connection;
  }
  const bulletinGenesis = getActiveServicesConfig().bulletin.genesis;
  const provider = createRemoteChainProvider(bulletinGenesis);
  if (provider === null) {
    throw new Error(
      `Bulletin Paseo (${bulletinGenesis}) is not in the supported chain set`,
    );
  }
  connection = provider((message: JsonRpcMessage) => {
    if (!isResponse(message)) {
      return;
    }
    if (typeof message.id !== "number") {
      return;
    }
    const entry = pending.get(message.id);
    if (entry === undefined) {
      return;
    }
    pending.delete(message.id);
    if ("error" in message) {
      const err = new Error(
        `bitswap_v1_get failed (code=${String(message.error.code)}): ${message.error.message}`,
      );
      (err as { code?: number }).code = message.error.code;
      entry.reject(err);
      return;
    }
    if (typeof message.result !== "string") {
      entry.reject(
        new Error(
          `bitswap_v1_get: expected hex string result, got ${typeof message.result}`,
        ),
      );
      return;
    }
    // Parse hex to bytes ONCE host-side. The sandbox-bound buffer is then
    // transferred zero-copy via postMessage instead of cloning an 8 MB
    // hex string and re-parsing on the other side.
    const hex = message.result;
    const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
    entry.resolve(hexToBytes(stripped));
  });
  return connection;
}

function errorCode(err: unknown): number | null {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "number") {
      return code;
    }
  }
  return null;
}

/** Fetch one CID block via the protocol iframe's smoldot. */
export async function bitswapGet(cid: string): Promise<Uint8Array> {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let discoveryDeadline: number | null = null;
  let discoveryFailures = 0;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `bitswap_v1_get(${cid}): timed out after ${String(TOTAL_BUDGET_MS)}ms (${String(attempt - 1)} attempts)`,
      );
    }
    const callTimeout = Math.min(PER_CALL_TIMEOUT_MS, remaining);
    try {
      return await sendOnce(cid, callTimeout);
    } catch (err) {
      const code = errorCode(err);
      if (code === ERR_INVALID_PARAMS) {
        throw err;
      }
      if (code === ERR_FAIL) {
        discoveryFailures += 1;
        discoveryDeadline ??= Date.now() + DISCOVERY_BUDGET_MS;
        if (Date.now() >= discoveryDeadline) {
          throw Object.assign(
            new Error(
              `bitswap_v1_get(${cid}): provider discovery exhausted after ${String(discoveryFailures)} failures over ${String(DISCOVERY_BUDGET_MS)}ms (${String(attempt)} total attempts): ${serializeError(err)}`,
            ),
            { code },
          );
        }
      } else if (code !== ERR_FAIL_RETRY && code !== ERR_FAIL_BACKOFF) {
        throw err;
      }
      // Discovery retries ramp on their own counter. Inheriting `attempt`
      // would start them pinned at the cap whenever a -32812 came first,
      // spending the window on two or three attempts instead of seven.
      const backoffAttempt =
        code === ERR_FAIL ? discoveryFailures : attempt - discoveryFailures;
      const delay = Math.min(
        BACKOFF_CAP_MS,
        BACKOFF_BASE_MS * 2 ** Math.min(Math.max(backoffAttempt, 1) - 1, 4),
        // Never sleep past a deadline we are about to be judged against:
        // overshooting either one burns the tail of the window on a wait
        // whose result is already decided.
        Math.max(0, deadline - Date.now()),
        ...(discoveryDeadline === null
          ? []
          : [Math.max(0, discoveryDeadline - Date.now())]),
      );
      log.warn(
        `[dot.li bitswap] ${cid} retry attempt=${String(attempt)} code=${String(code)} delay=${String(delay)}ms`,
      );
      await new Promise<void>((r) => setTimeout(r, delay));
    }
  }
}

function sendOnce(cid: string, timeoutMs: number): Promise<Uint8Array> {
  const id = nextId++;
  const conn = ensureConnection();
  return new Promise<Uint8Array>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      const err = new Error(
        `bitswap_v1_get(${cid}): per-call timed out after ${String(timeoutMs)}ms`,
      );
      (err as { code?: number }).code = ERR_FAIL_RETRY;
      reject(err);
    }, timeoutMs);
    pending.set(id, {
      resolve: (bytes) => {
        clearTimeout(timer);
        resolve(bytes);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    conn.send({
      jsonrpc: "2.0",
      id,
      method: "bitswap_v1_get",
      params: [cid],
    });
  });
}

interface BitswapGetMessage {
  type: "dotli:bitswap-get";
  id: string;
  cid: string;
}

interface BitswapResultOk {
  type: "dotli:bitswap-result";
  id: string;
  ok: true;
  bytes: Uint8Array;
}

interface BitswapResultErr {
  type: "dotli:bitswap-result";
  id: string;
  ok: false;
  error: string;
}

function isBitswapGetMessage(value: unknown): value is BitswapGetMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    obj.type === "dotli:bitswap-get" &&
    typeof obj.id === "string" &&
    typeof obj.cid === "string" &&
    obj.id.length > 0 &&
    obj.cid.length > 0
  );
}

/** Idempotent. Call once at host startup. */
export function listenForSandboxBitswap(): void {
  if (getBackend() === "rpc-gateway") {
    log.warn(
      "[dot.li bitswap-relay] Bitswap is unavailable in RPC gateway mode; sandbox bitswap requests will fail.",
    );
  } else if (
    !isRemoteChainSupported(getActiveServicesConfig().bulletin.genesis)
  ) {
    log.warn(
      "[dot.li bitswap-relay] Bulletin not in supported chain set; sandbox bitswap requests will fail.",
    );
  }
  window.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    if (!isBitswapGetMessage(data)) {
      return;
    }
    if (!isSandboxOrigin(event.origin)) {
      log.warn(
        `[dot.li bitswap-relay] Rejected bitswap-get from non-sandbox origin: ${event.origin}`,
      );
      return;
    }
    const source = event.source;
    if (source === null) {
      return;
    }
    void bitswapGet(data.cid)
      .then((bytes) => {
        const reply: BitswapResultOk = {
          type: "dotli:bitswap-result",
          id: data.id,
          ok: true,
          bytes,
        };
        // Transfer the underlying buffer zero-copy. The hex was already
        // parsed to bytes once host-side, so the sandbox gets the buffer
        // directly without another structured-clone of an 8 MB string.
        source.postMessage(reply, {
          targetOrigin: event.origin,
          transfer: [bytes.buffer as ArrayBuffer],
        });
      })
      .catch((err: unknown) => {
        const reply: BitswapResultErr = {
          type: "dotli:bitswap-result",
          id: data.id,
          ok: false,
          error: serializeError(err),
        };
        source.postMessage(reply, { targetOrigin: event.origin });
      });
  });
}
