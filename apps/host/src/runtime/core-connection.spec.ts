// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { TrUApiProductProvider } from '@parity/truapi-host';
import { enableDotliDebugBuffering, onDotliDebugEvent, type DotliDebugBusEvent } from '@dotli/truapi-debug';
import { wrapCoreProviderForDebug } from './core-connection.js';
import type { CoreConnection } from './page-core.js';
import { loginResponseFrame, makeProvider, type FakeCoreProvider } from './page-core.fake.js';

let stopListening: (() => void) | null = null;

afterEach(() => {
  stopListening?.();
  stopListening = null;
});

/** The debug panel open, as the host enables the bus before the panel subscribes. */
function openDebugPanel(): DotliDebugBusEvent[] {
  enableDotliDebugBuffering();
  const events: DotliDebugBusEvent[] = [];
  stopListening = onDotliDebugEvent(event => {
    events.push(event);
  });
  return events;
}

function connectionOver(provider: FakeCoreProvider): { connection: CoreConnection; close: Mock<() => void> } {
  const close = vi.fn<() => void>();
  return {
    connection: { provider: provider as unknown as TrUApiProductProvider, productId: 'doom.dot', close },
    close,
  };
}

describe('core connection debug tap', () => {
  it('As a dotli developer with the debug panel open, I see each frame between the product and its core with its direction', () => {
    // Given a wrapped connection whose product side listens
    const events = openDebugPanel();
    const core = makeProvider();
    const wrapped = wrapCoreProviderForDebug(connectionOver(core).connection);
    const toProduct: Uint8Array[] = [];
    wrapped.subscribe(message => {
      toProduct.push(message);
    });
    const request = loginResponseFrame('from-product', { success: true, value: 'Success' });
    const answer = loginResponseFrame('from-core', { success: true, value: 'Success' });

    // When the product sends a frame and the core answers
    wrapped.postMessage(request);
    core.listener?.(answer);

    // Then both reach their side and the panel sees each once, tagged with its direction
    expect(core.postMessage).toHaveBeenCalledWith(request);
    expect(toProduct).toEqual([answer]);
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'truapi',
        direction: 'incoming',
        productId: 'doom.dot',
        requestId: 'from-product',
      }),
      expect.objectContaining({
        kind: 'truapi',
        direction: 'outgoing',
        productId: 'doom.dot',
        requestId: 'from-core',
      }),
    ]);
  });

  it('As a dotli developer, I dispose a wrapped connection and the panel sees no frame after it', () => {
    // Given a wrapped connection with the debug panel open
    const events = openDebugPanel();
    const core = makeProvider();
    const { connection, close } = connectionOver(core);
    const wrapped = wrapCoreProviderForDebug(connection);

    // When it is disposed, then frames still arrive from either side
    wrapped.dispose();
    wrapped.postMessage(loginResponseFrame('late-product', { success: true, value: 'Success' }));
    core.listener?.(loginResponseFrame('late-core', { success: true, value: 'Success' }));

    // Then nothing is forwarded or shown, and the connection closed as a deliberate close
    expect(events).toEqual([]);
    expect(core.postMessage).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
