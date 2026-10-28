// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Reads content blocks through the host parent, so the sandbox runs no peer-to-peer node of its own.

import { parseHostToSandboxMessage, postToHost, type BitswapResultMessage } from '@dotli/sandbox-wire';
import { TIMEOUTS, isSiteOrigin } from '@dotli/config';
import { captureException, m, spans as S } from '@dotli/metrics';
import {
  createPendingReplies,
  getErrorName,
  log,
  createRandomId,
  realTimers,
  toError,
  withTimeout,
  type Timers,
} from '@dotli/shared';

type Params = {
  /** The sandbox's own window, where the host's answers and `pagehide` arrive. */
  window: Pick<Window, 'addEventListener'>;
  /** The host page that framed this sandbox. */
  parent: Pick<Window, 'postMessage'>;
  /** Whether a message from `origin` may come from the host. Never throws. */
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

  // The only notice that this frame went. Without it, each open request keeps running for tens of seconds.
  sandboxWindow.addEventListener('pagehide', event => {
    // A frame entering the back/forward cache can come back, still awaiting fetches the host would have aborted.
    if (event.persisted || replies.listIds().length === 0) {
      return;
    }
    postToHost(parent, { type: 'dotli:bitswap-abort', ids: replies.listIds(), frame });
    // Rejected rather than dropped, or the promises never settle: the reply listener ignores unknown ids.
    replies.rejectAll(() => new DOMException('bitswap-relay: aborted, the sandbox frame was torn down', 'AbortError'));
  });
  sandboxWindow.addEventListener('message', (event: MessageEvent<unknown>) => {
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
  });

  return {
    /**
     * Reads the block `cid` names through the host. Rejects with the host's error, with a timeout when the host never
     * answers, or with an `AbortError` when the frame goes away.
     */
    requestBlock,
  };

  function requestBlock(cid: string): Promise<Uint8Array> {
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
        // The abort is best effort: the request fails with the timeout even when the abort cannot be posted.
        try {
          postToHost(parent, { type: 'dotli:bitswap-abort', ids: [id], frame });
        } catch (error) {
          captureException(error, { flow: 'content', step: 'bitswap_abort', tags: { surface: 'sandbox_main' } });
          log.error(`${BRIDGE_LOG_TAG} bitswap bridge abort postMessage failed:`, error);
          m.count(S.SANDBOX_BITSWAP_ABORT, { outcome: 'error', reason: getErrorName(error) ?? 'unknown' });
        }
        return timeout;
      },
    });
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
