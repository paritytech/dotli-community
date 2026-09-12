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
/** Marks a local abort. A numeric code could collide: JSON-RPC reserves only
 *  -32768..-32000, so the rest of the space belongs to the chain. */
const ABORT_ERROR_NAME = "AbortError";

const PER_CALL_TIMEOUT_MS = 60_000;
const TOTAL_BUDGET_MS = 180_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 5_000;

// Retrying -32810 is a deliberate divergence from upstream. smoldot documents
// it as a permanent failure meaning the data is not in the network, and its own
// reference retry client retries only -32811 and -32812. The implementation
// does something narrower than the documentation claims, which is why we treat
// it as transient anyway, and why this should be raised upstream rather than
// carried here forever.
//
// It freezes the set of peers connected at the instant of the call, broadcasts
// a "have" request to exactly those, and fails the request the moment every one
// of them has answered DONT_HAVE. Peers that connect afterwards are never added
// to that set, and there is no provider lookup to fall back on. So it cannot
// distinguish "absent from the network" from "absent from the handful of peers
// this call happened to ask", and on a fresh page that handful is whatever was
// up at the time. Retrying takes a new, larger snapshot. Observed live, reloads
// that gave up on the first -32810 died at ~1.2s, while reloads that kept
// asking got the same CID 3 to 15 seconds later.
//
// Discovery is bounded so a CID that genuinely is not on the network fails in
// seconds rather than in three minutes.
//
// The bound counts attempts rather than elapsed time. A clock sounds more
// meaningful but is spent by anything that happens to take a while, including
// the -32812 runs this retry exists to survive, so a slow start could leave
// discovery two tries instead of ten. Counting attempts cannot be drained by
// something unrelated. Eight covers the 3 to 15 seconds observed live with
// room over it: 0.5 + 1 + 2 + 4 + 5 + 5 + 5 + 5 = 27.5s of grace.
const DISCOVERY_RETRIES = 8;

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

function abortError(cid: string): Error {
  const err = new Error(`bitswap_v1_get(${cid}): aborted`);
  err.name = ABORT_ERROR_NAME;
  return err;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === ABORT_ERROR_NAME;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // `addEventListener` never fires on a signal that is already aborted, so
    // an abort landing between the caller's check and this line would be
    // missed and the full delay served.
    if (signal?.aborted === true) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Fetch one CID block via the protocol iframe's smoldot.
 *
 * Pass `signal` from anything that can be torn down while a fetch is open. A
 * retrying call can now run for the full budget, so without one an abandoned
 * caller leaves it firing into a light client nobody is listening to.
 */
export async function bitswapGet(
  cid: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let discoveryAttempts = 0;
  let transientAttempts = 0;
  let attempt = 0;
  for (;;) {
    if (signal?.aborted === true) {
      throw abortError(cid);
    }
    attempt += 1;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `bitswap_v1_get(${cid}): timed out after ${String(TOTAL_BUDGET_MS)}ms (${String(attempt - 1)} attempts)`,
      );
    }
    const callTimeout = Math.min(PER_CALL_TIMEOUT_MS, remaining);
    try {
      return await sendOnce(cid, callTimeout, signal);
    } catch (err) {
      if (isAbortError(err)) {
        throw err;
      }
      const code = errorCode(err);
      if (code === ERR_INVALID_PARAMS) {
        throw err;
      }

      // Each kind of failure ramps on its own counter. Sharing one means a
      // couple of -32812s arrive first and pin the discovery retries at the
      // 5s cap, spending the allowance on two or three tries instead of eight.
      let backoffAttempt: number;
      if (code === ERR_FAIL) {
        discoveryAttempts += 1;
        if (discoveryAttempts > DISCOVERY_RETRIES) {
          throw Object.assign(
            new Error(
              `bitswap_v1_get(${cid}): provider discovery exhausted after ${String(discoveryAttempts)} failures (${String(attempt)} total attempts): ${serializeError(err)}`,
            ),
            { code },
          );
        }
        backoffAttempt = discoveryAttempts;
      } else if (code === ERR_FAIL_RETRY || code === ERR_FAIL_BACKOFF) {
        transientAttempts += 1;
        backoffAttempt = transientAttempts;
      } else {
        throw err;
      }

      // Each counter is incremented before it is read, so both are >= 1 here.
      // The floor of 1ms keeps the loop off a zero delay once the budget is
      // nearly spent; the next iteration's deadline check ends the call.
      const delay = Math.min(
        BACKOFF_CAP_MS,
        BACKOFF_BASE_MS * 2 ** Math.min(backoffAttempt - 1, 4),
        Math.max(1, deadline - Date.now()),
      );
      log.warn(
        `[dot.li bitswap] ${cid} retry attempt=${String(attempt)} code=${String(code)} delay=${String(delay)}ms`,
      );
      try {
        await sleep(delay, signal);
      } catch {
        throw abortError(cid);
      }
    }
  }
}

function sendOnce(
  cid: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const id = nextId++;
  const conn = ensureConnection();
  return new Promise<Uint8Array>((resolve, reject) => {
    // Same reason as in `sleep`, and the cost of missing it is larger here:
    // the fallback is the 60s per-call timeout rather than one backoff.
    if (signal?.aborted === true) {
      reject(abortError(cid));
      return;
    }
    // Every exit runs the same teardown. Doing it per-path leaked an abort
    // listener on the timeout path, and the caller's signal outlives the call
    // (one per subscription), so they accumulated for as long as it lived.
    const cleanup = (): void => {
      clearTimeout(timer);
      pending.delete(id);
      signal?.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(() => {
      const err = new Error(
        `bitswap_v1_get(${cid}): per-call timed out after ${String(timeoutMs)}ms`,
      );
      (err as { code?: number }).code = ERR_FAIL_RETRY;
      cleanup();
      reject(err);
    }, timeoutMs);
    // Abort has to reach the in-flight call, not just the gap between
    // retries. smoldot has no cancel for a request already issued, so the
    // entry is dropped and its late reply lands on an empty slot.
    function onAbort(): void {
      cleanup();
      reject(abortError(cid));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    pending.set(id, {
      resolve: (bytes) => {
        cleanup();
        resolve(bytes);
      },
      reject: (err) => {
        cleanup();
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
