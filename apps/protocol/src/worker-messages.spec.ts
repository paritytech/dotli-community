// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { ProtocolEnvelope } from '@dotli/protocol';
import { disconnectOnPageHide, relayFromWorker } from './worker-messages.js';

/** The iframe's end of the worker port. */
function iframePort(): { port: MessagePort; posted: unknown[]; fromWorker: (data: unknown) => void } {
  const posted: unknown[] = [];
  const listeners: ((event: MessageEvent) => void)[] = [];
  const port = {
    addEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
      listeners.push(listener);
    },
    postMessage: (message: unknown) => {
      posted.push(message);
    },
  } as unknown as MessagePort;
  return {
    port,
    posted,
    fromWorker: data => {
      for (const listener of listeners) {
        listener(new MessageEvent('message', { data }));
      }
    },
  };
}

/** The iframe's page, which hides when the host removes the frame or the tab navigates. */
function iframePage(): { target: EventTarget; hide: (persisted: boolean) => void } {
  const target = new EventTarget();
  return {
    target,
    hide: persisted => {
      target.dispatchEvent(Object.assign(new Event('pagehide'), { persisted }));
    },
  };
}

function closablePort(): {
  port: Pick<MessagePort, 'postMessage' | 'close'>;
  posted: unknown[];
  closed: () => boolean;
} {
  const posted: unknown[] = [];
  let closed = false;
  return {
    port: {
      postMessage: (message: unknown) => {
        posted.push(message);
      },
      close: () => {
        closed = true;
      },
    },
    posted,
    closed: () => closed,
  };
}

describe("the iframe's end of the worker port", () => {
  it("As a tab's protocol iframe, I answer the worker's heartbeat so it keeps my port", () => {
    // Given
    const { port, posted, fromWorker } = iframePort();
    const forward = vi.fn<(envelope: ProtocolEnvelope) => void>();
    relayFromWorker(port, forward);

    // When
    fromWorker({ type: 'ping' });

    // Then
    expect(posted).toEqual([{ type: 'pong' }]);
    expect(forward).not.toHaveBeenCalled();
  });

  it("As a host page, I hear the worker's envelopes through my iframe and nothing else", () => {
    // Given
    const { port, posted, fromWorker } = iframePort();
    const forward = vi.fn<(envelope: ProtocolEnvelope) => void>();
    relayFromWorker(port, forward);
    const fatal: ProtocolEnvelope = { namespace: 'dotli:protocol', kind: 'fatal', message: 'wasm trap' };

    // When
    fromWorker({ type: 'relay-response', envelope: fatal });
    fromWorker({ type: 'ready' });

    // Then
    expect(forward.mock.calls).toEqual([[fatal]]);
    expect(posted).toEqual([]);
  });

  it("As a tab's protocol iframe the host removes, I tell the worker I am gone so it frees my connections at once", () => {
    // Given
    const page = iframePage();
    const { port, posted, closed } = closablePort();
    disconnectOnPageHide(page.target, port);

    // When
    page.hide(false);

    // Then
    expect(posted).toEqual([{ type: 'disconnect' }]);
    expect(closed()).toBe(true);
  });

  it("As a tab's protocol iframe kept in the back-forward cache, I keep my port so I am served when the page comes back", () => {
    // Given
    const page = iframePage();
    const { port, posted, closed } = closablePort();
    disconnectOnPageHide(page.target, port);

    // When
    page.hide(true);

    // Then
    expect(posted).toEqual([]);
    expect(closed()).toBe(false);
  });

  it("As a tab's protocol iframe whose port already closed, I still close it on unload without throwing", () => {
    // Given
    const page = iframePage();
    const { port, closed } = closablePort();
    port.postMessage = () => {
      throw new DOMException('port closed', 'InvalidStateError');
    };
    disconnectOnPageHide(page.target, port);

    // When
    page.hide(false);

    // Then
    expect(closed()).toBe(true);
  });
});
