// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Asks the host parent, which proxies each block request to the protocol iframe's smoldot.

import { parseHostToSandboxMessage, postToHost, type BitswapResultMessage } from '@dotli/sandbox-wire';
import { TIMEOUTS, isSiteOrigin } from '@dotli/config';
import { createPendingReplies, log, randomId, toError, withTimeout } from '@dotli/shared';

export type BitswapBridgeDeps = {
  /** The sandbox's own window, where the host's answers and `pagehide` arrive. */
  window: Pick<EventTarget, 'addEventListener'>;
  /** The host page that framed this sandbox. */
  parent: Pick<Window, 'postMessage'>;
  isHostOrigin: (origin: string) => boolean;
};

export type BitswapBridge = {
  /** `BitswapBlockSource` for `@dotli/content/fetch`. */
  requestBlock: (cid: string) => Promise<Uint8Array>;
};

/** A host page origin: the root or a product subdomain of `baseDomain`, or a local one, never a sandbox. */
export function hostOriginRule(baseDomain: string): (origin: string) => boolean {
  return origin => {
    if (URL.canParse(origin) && new URL(origin).hostname === '127.0.0.1') {
      return true;
    }
    return isSiteOrigin(origin, baseDomain);
  };
}

/** Keeps the host error's name and code, since every rebuilt error shares this stack and Sentry splits them by name. */
function hostError(reply: Extract<BitswapResultMessage, { ok: false }>): Error {
  const err = new Error(reply.error ?? 'bitswap-relay: malformed result envelope');
  if (typeof reply.errorName === 'string' && reply.errorName !== '') {
    err.name = reply.errorName;
  }
  if (typeof reply.code === 'number') {
    (err as { code?: number }).code = reply.code;
  }
  return err;
}

/** Names a wait the host never answered, so Sentry groups it apart from the host's own failures. */
class BitswapBridgeTimeoutError extends Error {
  override name = 'BitswapBridgeTimeoutError';
}

export function createBitswapBridge(deps: BitswapBridgeDeps): BitswapBridge {
  const { parent, isHostOrigin } = deps;
  let nextId = 1;
  // The host reads this document's abort after the document is gone, so the abort names its frame instead.
  const frame = randomId();
  const replies = createPendingReplies<string, Uint8Array>();

  // Nothing else tells the host this frame went, and a fetch with no providers retries for tens of seconds.
  deps.window.addEventListener('pagehide', event => {
    // A frame entering the back/forward cache can come back, still awaiting fetches the host would have aborted.
    if ((event as PageTransitionEvent).persisted || replies.ids().length === 0) {
      return;
    }
    postToHost(parent, { type: 'dotli:bitswap-abort', ids: replies.ids(), frame });
    // Rejected rather than dropped, or the promises never settle: the reply listener ignores unknown ids.
    replies.rejectAll(() => new DOMException('bitswap-relay: aborted, the sandbox frame was torn down', 'AbortError'));
  });
  deps.window.addEventListener('message', event => {
    const message = event as MessageEvent<unknown>;
    // Only the host that framed this sandbox answers its fetches.
    if (message.source !== parent || !isHostOrigin(message.origin)) {
      return;
    }
    const reply = parseHostToSandboxMessage(message.data);
    if (reply === null) {
      return;
    }
    if (reply.ok) {
      replies.resolve(reply.id, reply.bytes);
    } else {
      replies.reject(reply.id, hostError(reply));
    }
  });

  return {
    requestBlock: cid => {
      const id = `bitswap-${String(nextId++)}-${String(Date.now())}`;
      const reply = replies.wait(id);
      try {
        postToHost(parent, { type: 'dotli:bitswap-get', id, cid, frame });
      } catch (err) {
        log.error('[dot.li sandbox] bitswap bridge postMessage failed:', err);
        replies.reject(id, toError(err));
      }
      // The host's relay gives up at its own budget, so a reply that never comes is dropped, not awaited forever.
      return withTimeout(reply, TIMEOUTS.BITSWAP_TOTAL_BUDGET + TIMEOUTS.RESPONSE_DELIVERY_GRACE, () => {
        const timeout = new BitswapBridgeTimeoutError(`bitswap-bridge: no reply for ${cid} from the host`);
        replies.reject(id, timeout);
        // The abort is best effort: the request fails with the timeout even when the abort cannot be posted.
        try {
          postToHost(parent, { type: 'dotli:bitswap-abort', ids: [id], frame });
        } catch (err) {
          log.error('[dot.li sandbox] bitswap bridge abort postMessage failed:', err);
        }
        return timeout;
      });
    },
  };
}
