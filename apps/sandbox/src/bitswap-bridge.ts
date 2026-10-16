// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Asks the host parent, which proxies each block request to the protocol iframe's smoldot.

import { log } from '@dotli/shared';

interface BitswapResultMessage {
  type: 'dotli:bitswap-result';
  id: string;
  ok: boolean;
  bytes?: Uint8Array;
  error?: string;
  errorName?: string;
  code?: number;
}

function isBitswapResultMessage(value: unknown): value is BitswapResultMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return obj['type'] === 'dotli:bitswap-result' && typeof obj['id'] === 'string' && typeof obj['ok'] === 'boolean';
}

let nextId = 1;
const pending = new Map<string, { resolve: (bytes: Uint8Array) => void; reject: (err: Error) => void }>();
let listenerInstalled = false;

function ensureListener(): void {
  if (listenerInstalled) {
    return;
  }
  listenerInstalled = true;
  // Nothing else tells the host this frame went, and a fetch with no providers retries for tens of seconds.
  window.addEventListener('pagehide', (event: PageTransitionEvent) => {
    // A frame entering the back/forward cache can come back, still awaiting fetches the host would have aborted.
    if (event.persisted || pending.size === 0) {
      return;
    }
    window.parent.postMessage({ type: 'dotli:bitswap-abort', ids: [...pending.keys()] }, '*');
    // Reject rather than clear, or the promises never settle: the reply listener ignores unknown ids.
    for (const [, entry] of pending) {
      entry.reject(new Error('bitswap-relay: aborted, the sandbox frame was torn down'));
    }
    pending.clear();
  });
  window.addEventListener('message', (event: MessageEvent) => {
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
      entry.reject(hostError(reply));
    }
  });
}

/** Keeps the host error's name and code, since every rebuilt error shares this stack and Sentry splits them by name. */
function hostError(reply: BitswapResultMessage): Error {
  const err = new Error(reply.error ?? 'bitswap-relay: malformed result envelope');
  if (typeof reply.errorName === 'string' && reply.errorName !== '') {
    err.name = reply.errorName;
  }
  if (typeof reply.code === 'number') {
    (err as { code?: number }).code = reply.code;
  }
  return err;
}

/** `BitswapBlockSource` for `@dotli/content/fetch`. */
export async function requestBitswapBlock(cid: string): Promise<Uint8Array> {
  ensureListener();
  const id = `bitswap-${String(nextId++)}-${String(Date.now())}`;
  return new Promise<Uint8Array>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      window.parent.postMessage({ type: 'dotli:bitswap-get', id, cid }, '*');
    } catch (err) {
      pending.delete(id);
      log.error('[dot.li sandbox] bitswap bridge postMessage failed:', err);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
