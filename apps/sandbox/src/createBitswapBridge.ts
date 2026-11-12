// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Reads content blocks through the host parent, so the sandbox runs no peer-to-peer node of its own.

import { parseHostToSandboxMessage, postToHost, type BitswapResultMessage } from '@dotli/sandbox-wire';
import { TIMEOUTS, isSiteOrigin } from '@dotli/config';
import { createReporter, defineCount } from '@dotli/metrics';
import {
  createPendingReplies,
  log,
  createRandomId,
  realTimers,
  toError,
  withTimeout,
  type Timers,
} from '@dotli/shared';

const report = createReporter({ flow: 'content' });

/**
 * An abort the sandbox's block bridge could not post to the host after a request timed out. Tagged `outcome` (error)
 * and `reason` (the error's name).
 */
const sandboxBitswapAbortMetric = defineCount<'error'>('sandbox.bitswap_abort');

type Params = {
  /** The sandbox's own window, where the host's answers and `pagehide` arrive. */
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** The host page that framed this sandbox. */
  parent: Pick<Window, 'postMessage'>;
  /** Whether a message from `origin` may come from the host. */
  isHostOrigin: (origin: string) => boolean;
  /** The clock that stamps each request id, and the timers its wait for an answer runs on. */
  timers?: Timers;
};

export type BitswapBridge = ReturnType<typeof createBitswapBridge>;

/** The tag that opens an error line of the block bridge. */
const BRIDGE_LOG_TAG = '[dot.li sandbox]';

/** A bridge that asks the host parent for blocks and settles each request with its answer. */
export function createBitswapBridge({ window: sandboxWindow, parent, isHostOrigin, timers = realTimers }: Params) {
  let nextId = 1;
  // Each abort names this frame, since it may be read after this document is gone.
  const frame = createRandomId();
  const replies = createPendingReplies<string, Uint8Array>();
  // Aborted by `dispose`, so a disposed bridge starts no new request.
  const lifetime = new AbortController();

  sandboxWindow.addEventListener('message', onMessage);
  // The only notice that this frame went. Without it, each open request keeps running for tens of seconds.
  sandboxWindow.addEventListener('pagehide', onPageHide);

  return {
    /**
     * Reads the block `cid` names through the host. Rejects with the host's error, with a timeout when the host never
     * answers, or with an `AbortError` when the frame goes away or the bridge is disposed. A call after `dispose()`
     * rejects at once with an `AbortError` and asks the host nothing.
     */
    requestBlock,
    /**
     * Stops listening on the sandbox's window and aborts the open requests as a frame torn down does, so each rejects
     * with an `AbortError` and the host drops its fetch, safe to call more than once and never throwing.
     */
    dispose,
  };

  function dispose(): void {
    lifetime.abort();
    abortOpenRequests();
    sandboxWindow.removeEventListener('pagehide', onPageHide);
    sandboxWindow.removeEventListener('message', onMessage);
  }

  function onPageHide(event: PageTransitionEvent): void {
    // A frame entering the back/forward cache can come back, still awaiting fetches the host would have aborted.
    if (event.persisted) {
      return;
    }
    abortOpenRequests();
  }

  function abortOpenRequests(): void {
    const ids = replies.listIds();
    if (ids.length === 0) {
      return;
    }
    postAbort(ids);
    // Rejected rather than dropped, or the promises never settle: the reply listener ignores unknown ids.
    replies.rejectAll(createAbortError);
  }

  function onMessage(event: MessageEvent<unknown>): void {
    // Only the host that framed this sandbox answers its fetches.
    if (event.source !== parent || !isHostOrigin(event.origin)) {
      return;
    }
    const reply = parseHostToSandboxMessage(event.data);
    if (reply === null) {
      return;
    }
    if (reply.ok) {
      replies.resolve(reply.id, reply.bytes);
    } else {
      replies.reject(reply.id, toHostError(reply));
    }
  }

  function requestBlock(cid: string): Promise<Uint8Array> {
    if (lifetime.signal.aborted) {
      return Promise.reject(createAbortError());
    }
    const id = `bitswap-${String(nextId++)}-${String(timers.now())}`;
    const reply = replies.wait(id);
    try {
      postToHost(parent, { type: 'dotli:bitswap-get', id, cid, frame });
    } catch (error) {
      log.error(`${BRIDGE_LOG_TAG} bitswap bridge postMessage failed:`, error);
      replies.reject(id, toError(error));
    }
    // A reply that never comes is dropped once the relay's budget and a grace have passed, not awaited forever.
    return withTimeout({
      work: reply,
      ms: TIMEOUTS.BITSWAP_TOTAL_BUDGET + TIMEOUTS.RESPONSE_DELIVERY_GRACE,
      timers,
      timeoutError: () => {
        const timeout = new BitswapBridgeTimeoutError(`bitswap-bridge: no reply for ${cid} from the host`);
        replies.reject(id, timeout);
        postAbort([id]);
        return timeout;
      },
    });
  }

  /** Tells the host to drop the fetches `ids` name. */
  function postAbort(ids: string[]): void {
    // The abort is best effort: each request fails as it would even when the abort cannot be posted.
    try {
      postToHost(parent, { type: 'dotli:bitswap-abort', ids, frame });
    } catch (error) {
      report.defect(error, {
        step: 'bitswap_abort',
        metric: sandboxBitswapAbortMetric,
        message: `${BRIDGE_LOG_TAG} bitswap bridge abort postMessage failed:`,
        tags: { surface: 'sandbox_main' },
      });
    }
  }
}

/** A host page origin: the root or a product subdomain of `baseDomain`, or a local one, never a sandbox. */
export function createHostOriginRule(baseDomain: string): (origin: string) => boolean {
  return isHostOrigin;

  function isHostOrigin(origin: string): boolean {
    if (URL.canParse(origin) && new URL(origin).hostname === '127.0.0.1') {
      return true;
    }
    return isSiteOrigin(origin, baseDomain);
  }
}

/** The `AbortError` a read hears when the bridge stops serving it. */
function createAbortError(): DOMException {
  return new DOMException('bitswap-relay: aborted, the bridge stopped', 'AbortError');
}

/** Keeps the host error's name and code, since every rebuilt error shares this stack and Sentry splits them by name. */
function toHostError(reply: Extract<BitswapResultMessage, { ok: false }>): Error {
  const error = new Error(reply.error ?? 'bitswap-relay: malformed result envelope');
  if (typeof reply.errorName === 'string' && reply.errorName !== '') {
    error.name = reply.errorName;
  }
  if (typeof reply.code === 'number') {
    // A plain `Error` carries no `code`, which the host's error had.
    return Object.assign(error, { code: reply.code });
  }
  return error;
}

/** Names a wait the host never answered, so Sentry groups it apart from the host's own failures. */
class BitswapBridgeTimeoutError extends Error {
  override name = 'BitswapBridgeTimeoutError';
}
