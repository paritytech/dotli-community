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
// transient and retryable. INVALID_PARAMS and FAIL are terminal.
const ERR_INVALID_PARAMS = -32602;
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
let progressCallback: ProgressCallback | null = null;
let bytesFetched = 0;
let totalBytes: number | null = null;
let firstBlockAt = 0;

export function onContentProgress(cb: ProgressCallback): void {
  progressCallback = cb;
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
  progressCallback?.({
    bytesFetched,
    totalBytes,
    bytesPerSecond: elapsed > 0 ? (bytesFetched / elapsed) * 1000 : 0,
  });
}

const PER_CALL_TIMEOUT_MS = 60_000;
const TOTAL_BUDGET_MS = 180_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 5_000;

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
      if (code === ERR_INVALID_PARAMS || code === ERR_FAIL) {
        throw err;
      }
      if (code === ERR_FAIL_RETRY || code === ERR_FAIL_BACKOFF) {
        const delay = Math.min(
          BACKOFF_CAP_MS,
          BACKOFF_BASE_MS * 2 ** Math.min(attempt - 1, 4),
        );
        log.warn(
          `[dot.li bitswap] ${cid} retry attempt=${String(attempt)} code=${String(code)} delay=${String(delay)}ms`,
        );
        await new Promise<void>((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
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
