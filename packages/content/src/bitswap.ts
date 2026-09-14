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
// the retryable pair. Anything else, including an invalid CID, falls to the
// terminal branch below.
const ERR_FAIL = -32810;
const ERR_FAIL_RETRY = -32811;
const ERR_FAIL_BACKOFF = -32812;

/**
 * Byte accounting for the content download.
 *
 * Every block the sandbox needs is fetched here, so this is the one place
 * that sees the whole transfer. The first dag-pb block is the DAG root, and
 * its links carry `Tsize`, the cumulative size of each subtree. Summing them
 * gives the total up front, which turns the download into a real percentage
 * instead of a timer.
 */
export interface ContentProgress {
  bytesFetched: number;
  totalBytes: number | null;
  bytesPerSecond: number;
}

type ProgressCallback = (progress: ContentProgress) => void;
// A set, not a slot: the resolution trace and the loading bar both listen,
// and a slot would hand the stream to whichever registered last.
const progressCallbacks = new Set<ProgressCallback>();
let bytesFetched = 0;
let totalBytes: number | null = null;
let firstBlockAt = 0;

export function onContentProgress(cb: ProgressCallback): () => void {
  progressCallbacks.add(cb);
  return () => {
    progressCallbacks.delete(cb);
  };
}

function readDagTotal(bytes: Uint8Array): number | null {
  try {
    // dag-pb links are field 2, each an embedded message carrying Hash (1),
    // Name (2), and Tsize (3) as a varint. Reading Tsize directly keeps the
    // 40kB `@ipld/dag-pb` decoder out of the eager host bundle.
    let i = 0;
    let total = 0;
    let sawLink = false;
    const readVarint = (): number => {
      let result = 0;
      let shift = 0;
      while (i < bytes.length) {
        const b = bytes[i];
        i += 1;
        result += (b & 0x7f) * 2 ** shift;
        if ((b & 0x80) === 0) {
          break;
        }
        shift += 7;
      }
      return result;
    };
    while (i < bytes.length) {
      const key = readVarint();
      const field = key >> 3;
      const wire = key & 0x7;
      if (wire !== 2) {
        return null;
      }
      const len = readVarint();
      if (field === 2) {
        // A PBLink submessage. Walk it for Tsize (field 3, varint).
        const end = i + len;
        while (i < end) {
          const lk = readVarint();
          const lf = lk >> 3;
          const lw = lk & 0x7;
          if (lw === 0) {
            const v = readVarint();
            if (lf === 3) {
              total += v;
              sawLink = true;
            }
          } else if (lw === 2) {
            // Read the length first: `i += readVarint()` would capture the
            // old `i` before the call advanced it past the varint itself.
            const skip = readVarint();
            i += skip;
          } else {
            return null;
          }
        }
        i = end;
      } else {
        i += len;
      }
    }
    return sawLink ? total : null;
  } catch {
    return null;
  }
}

function noteBlock(bytes: Uint8Array): void {
  if (firstBlockAt === 0) {
    firstBlockAt = performance.now();
    totalBytes = readDagTotal(bytes);
  }
  bytesFetched += bytes.length;
  const elapsed = performance.now() - firstBlockAt;
  const progress = {
    bytesFetched,
    totalBytes,
    bytesPerSecond: elapsed > 0 ? (bytesFetched / elapsed) * 1000 : 0,
  };
  for (const cb of progressCallbacks) {
    cb(progress);
  }
}
/** Marks a local abort. A numeric code could collide: JSON-RPC reserves only
 *  -32768..-32000, so the rest of the space belongs to the chain. */
const ABORT_ERROR_NAME = "AbortError";

const PER_CALL_TIMEOUT_MS = 60_000;
const TOTAL_BUDGET_MS = 180_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 5_000;

// smoldot calls -32810 permanent, but it only means every peer connected at
// that instant answered DONT_HAVE: it never adds later peers and never looks up
// providers, so a retry gets a fresh, larger set. Bounded by attempts and not a
// clock, which anything slow in between drains, including the -32812 runs this
// exists to survive. Eight buys 27.5s against the 3 to 15 observed live.
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

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // `addEventListener` never fires on a signal that is already aborted.
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
    attempt += 1;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `bitswap_v1_get(${cid}): timed out after ${String(TOTAL_BUDGET_MS)}ms (${String(attempt - 1)} attempts made)`,
      );
    }
    const callTimeout = Math.min(PER_CALL_TIMEOUT_MS, remaining);
    try {
      return await sendOnce(cid, callTimeout, signal);
    } catch (err) {
      const code = errorCode(err);

      // Each kind of failure ramps on its own counter. Sharing one means a
      // couple of -32812s arrive first and pin the discovery retries at the
      // 5s cap, spending the allowance on two or three tries instead of eight.
      let backoffAttempt: number;
      if (code === ERR_FAIL) {
        discoveryAttempts += 1;
        if (discoveryAttempts > DISCOVERY_RETRIES) {
          throw Object.assign(
            new Error(
              `bitswap_v1_get(${cid}): provider discovery exhausted after ${String(discoveryAttempts)} failures (${String(attempt)} attempts made): ${serializeError(err)}`,
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
      // nearly spent. The next iteration's deadline check ends the call.
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

interface BitswapAbortMessage {
  type: "dotli:bitswap-abort";
  ids: string[];
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

function isBitswapAbortMessage(value: unknown): value is BitswapAbortMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    obj.type === "dotli:bitswap-abort" &&
    Array.isArray(obj.ids) &&
    obj.ids.every((id) => typeof id === "string")
  );
}

/**
 * Live relayed fetches, per requesting frame and then per request id.
 *
 * The relay outlives the sandbox it serves, so a fetch started for a page the
 * user has navigated away from keeps retrying and posts its result into a dead
 * frame. Nothing in the DOM tells us the frame went: the sandbox has to say so,
 * which it does on `pagehide`.
 *
 * The frame is the outer key for two reasons. Origin alone does not identify
 * one, and every product runs at a sandbox origin, so origin-only gating would
 * let any product cancel another's fetches with ids that are sequential and so
 * guessable in bulk. And ids restart at 1 in every frame, so a flat map lets a
 * second frame's entry overwrite a first frame's and strand it unabortable —
 * `renderIframe` keeps the outgoing product alive while its replacement boots,
 * so two frames really do coexist.
 */
const inFlight = new Map<MessageEventSource, Map<string, AbortController>>();
let relayInstalled = false;

/** Idempotent. Call once at host startup. */
export function listenForSandboxBitswap(): void {
  if (relayInstalled) {
    return;
  }
  relayInstalled = true;
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
    if (isBitswapAbortMessage(data)) {
      if (!isSandboxOrigin(event.origin) || event.source === null) {
        return;
      }
      // Reaching only this frame's own fetches is what stops one product
      // cancelling another's.
      const own = inFlight.get(event.source);
      if (own === undefined) {
        return;
      }
      for (const id of data.ids) {
        own.get(id)?.abort();
        own.delete(id);
      }
      if (own.size === 0) {
        inFlight.delete(event.source);
      }
      return;
    }
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
    const aborter = new AbortController();
    let own = inFlight.get(source);
    if (own === undefined) {
      own = new Map<string, AbortController>();
      inFlight.set(source, own);
    }
    own.set(data.id, aborter);
    void bitswapGet(data.cid, aborter.signal)
      .finally(() => {
        // A frame reusing an id while its earlier fetch is still open would
        // otherwise have that earlier fetch's cleanup drop the newer entry.
        if (own.get(data.id) === aborter) {
          own.delete(data.id);
        }
        if (own.size === 0) {
          inFlight.delete(source);
        }
      })
      .then((bytes) => {
        noteBlock(bytes);
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

/** Internal seams for unit tests. Not part of the module API. */
export const __testing = { noteBlock };
