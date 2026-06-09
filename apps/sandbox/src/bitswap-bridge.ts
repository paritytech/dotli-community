// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Sandbox-side bitswap bridge: postMessages the host parent which proxies
// the request to the protocol iframe's smoldot.

import { log } from "@dotli/shared/log";

interface BitswapResultMessage {
  type: "dotli:bitswap-result";
  id: string;
  ok: boolean;
  bytes?: Uint8Array;
  error?: string;
}

function isBitswapResultMessage(value: unknown): value is BitswapResultMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    obj.type === "dotli:bitswap-result" &&
    typeof obj.id === "string" &&
    typeof obj.ok === "boolean"
  );
}

let nextId = 1;
const pending = new Map<
  string,
  { resolve: (bytes: Uint8Array) => void; reject: (err: Error) => void }
>();
let listenerInstalled = false;

function ensureListener(): void {
  if (listenerInstalled) {
    return;
  }
  listenerInstalled = true;
  window.addEventListener("message", (event: MessageEvent) => {
    if (!isBitswapResultMessage(event.data)) {
      return;
    }
    const reply = event.data;
    const entry = pending.get(reply.id);
    if (entry === undefined) {
      return;
    }
    pending.delete(reply.id);
    if (reply.ok && reply.bytes instanceof Uint8Array) {
      entry.resolve(reply.bytes);
    } else {
      entry.reject(
        new Error(reply.error ?? "bitswap-relay: malformed result envelope"),
      );
    }
  });
}

/** `BitswapBlockSource` for `@dotli/content/fetch`. */
export async function requestBitswapBlock(cid: string): Promise<Uint8Array> {
  ensureListener();
  const id = `bitswap-${String(nextId++)}-${String(Date.now())}`;
  return new Promise<Uint8Array>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      window.parent.postMessage({ type: "dotli:bitswap-get", id, cid }, "*");
    } catch (err) {
      pending.delete(id);
      log.error("[dot.li sandbox] bitswap bridge postMessage failed:", err);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
