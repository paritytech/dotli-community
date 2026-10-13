// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The messages between a tab's protocol iframe and the SharedWorker, over the port the worker hands each tab, and the
// iframe's end of that port.

import type { ProtocolEnvelope, ProtocolRequestEnvelope } from '@dotli/protocol';

/** Iframe to worker: a host page's request. */
export interface SWRelayRequest {
  type: 'relay-request';
  envelope: ProtocolRequestEnvelope;
  origin: string;
  /** The sending tab's page load. Per request, because this worker serves every tab at once. */
  resolutionId?: string;
}

/** Iframe to worker: the tab is unloading. */
export interface SWDisconnect {
  type: 'disconnect';
}

/** Iframe to worker: the answer to a ping, so the worker keeps the tab's port. */
export interface SWPong {
  type: 'pong';
}

export type SWInbound = SWRelayRequest | SWDisconnect | SWPong;

/** Worker to iframe: an envelope for the host page. */
export interface SWRelayResponse {
  type: 'relay-response';
  envelope: ProtocolEnvelope;
}

/** Worker to iframe: the light client is synced, so the iframe tells its host it is ready. */
export interface SWReady {
  type: 'ready';
}

/** Worker to iframe: the light client will never be ready, and why. */
export interface SWError {
  type: 'error';
  message: string;
}

/** Worker to iframe: the heartbeat, answered with a pong. */
export interface SWPing {
  type: 'ping';
}

export type SWOutbound = SWRelayResponse | SWReady | SWError | SWPing;

/** The iframe's end of the port: relays the worker's envelopes to the host page and answers its heartbeat. */
export function relayFromWorker(
  port: Pick<MessagePort, 'addEventListener' | 'postMessage'>,
  forward: (envelope: ProtocolEnvelope) => void,
): void {
  port.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as SWOutbound | null;
    if (data?.type === 'ping') {
      const pong: SWPong = { type: 'pong' };
      port.postMessage(pong);
      return;
    }
    if (data?.type === 'relay-response') {
      forward(data.envelope);
    }
  });
}

/**
 * Tells the worker the tab is gone once its page is hidden for good, so the worker frees its connections at once.
 * `pagehide` and not `beforeunload`, because a frame the host removes fires only the former. A page kept in the
 * back-forward cache may come back, so it keeps its port.
 */
export function disconnectOnPageHide(
  target: Pick<EventTarget, 'addEventListener'>,
  port: Pick<MessagePort, 'postMessage' | 'close'>,
): void {
  target.addEventListener('pagehide', event => {
    if ((event as PageTransitionEvent).persisted) {
      return;
    }
    try {
      const msg: SWDisconnect = { type: 'disconnect' };
      port.postMessage(msg);
      // eslint-disable-next-line no-restricted-syntax -- best-effort unload signal, the port may already be closed.
    } catch {
      /* port already closed on unload, safe */
    }
    port.close();
  });
}
