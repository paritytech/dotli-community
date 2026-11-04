// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { asProductId } from '@parity/truapi';
import { describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import type { TrUApiProductProvider } from '@parity/truapi-host';
import { debugBus, type DebugBusEvent } from '@dotli/truapi-debug';
import type { CoreConnection } from './createPageCore.js';
import { wireDescriber } from './createWireDescriber.js';
import { ownCoreConnection } from './ownCoreConnection.js';
import { bindReports } from '../testing/bindReports.js';
import { buildLoginResponseFrame } from '../testing/buildLoginResponseFrame.js';
import { createFakeProvider, type FakeCoreProvider } from './createPageCore.fake.js';

/** The debug panel open, as the host enables the bus before the panel subscribes. Unsubscribes when the test ends. */
function openDebugPanel(): DebugBusEvent[] {
  debugBus.enableBuffering();
  const events: DebugBusEvent[] = [];
  onTestFinished(
    debugBus.subscribe(event => {
      events.push(event);
    }),
  );
  return events;
}

function connectOver(provider: FakeCoreProvider): { connection: CoreConnection; close: Mock<() => void> } {
  const close = vi.fn<() => void>();
  return {
    // The fake has the wire and permission members only, not the full provider interface.
    connection: { provider: provider as unknown as TrUApiProductProvider, productId: asProductId('doom.dot'), close },
    close,
  };
}

describe('core connection debug tap', () => {
  it('As a dotli developer with the debug panel open, I see each frame between the product and its core with its direction', async () => {
    // Given a wrapped connection whose product side listens
    const events = openDebugPanel();
    await wireDescriber.preload();
    const core = createFakeProvider();
    const wrapped = ownCoreConnection(connectOver(core).connection);
    const toProduct: Uint8Array[] = [];
    wrapped.subscribe(message => {
      toProduct.push(message);
    });
    const request = buildLoginResponseFrame('from-product', { kind: 'success', value: 'Success' });
    const answer = buildLoginResponseFrame('from-core', { kind: 'success', value: 'Success' });

    // When the product sends a frame and the core answers
    wrapped.postMessage(request);
    core.listener?.(answer);
    // The describer answers in order, so once a later ask settles every earlier frame has reached the panel.
    await wireDescriber.preload();

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

  it('As a dotli developer, I dispose a wrapped connection and the panel sees no frame after it', async () => {
    // Given a wrapped connection with the debug panel open
    const events = openDebugPanel();
    await wireDescriber.preload();
    const core = createFakeProvider();
    const { connection, close } = connectOver(core);
    const wrapped = ownCoreConnection(connection);

    // When it is disposed and frames arrive from either side after it
    wrapped.dispose();
    wrapped.postMessage(buildLoginResponseFrame('late-product', { kind: 'success', value: 'Success' }));
    core.listener?.(buildLoginResponseFrame('late-core', { kind: 'success', value: 'Success' }));
    // The describer answers in order, so once a later ask settles every earlier frame has reached the panel.
    await wireDescriber.preload();

    // Then nothing is forwarded or shown, and the connection closed as a deliberate close
    expect(events).toEqual([]);
    expect(core.postMessage).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('As a dotli developer in debug mode, I send two frames back to back and the panel shows them in the order they crossed', async () => {
    // Given a wrapped connection with the debug panel open
    const events = openDebugPanel();
    await wireDescriber.preload();
    const core = createFakeProvider();
    const wrapped = ownCoreConnection(connectOver(core).connection);

    // When two frames cross back to back
    wrapped.postMessage(buildLoginResponseFrame('first', { kind: 'success', value: 'Success' }));
    wrapped.postMessage(buildLoginResponseFrame('second', { kind: 'success', value: 'Success' }));
    // The describer answers in order, so once a later ask settles every earlier frame has reached the panel.
    await wireDescriber.preload();

    // Then the panel sees them in the order they crossed
    expect(events.map(event => ('requestId' in event ? event.requestId : null))).toEqual(['first', 'second']);
  });
});

describe('core connection listeners', () => {
  it('As a dotli integrator, I listen twice on a core connection and the second listener still hears a frame when the first throws', () => {
    // Given a first listener that throws and a second that collects
    bindReports();
    const core = createFakeProvider();
    const wrapped = ownCoreConnection(connectOver(core).connection);
    const heard: Uint8Array[] = [];
    wrapped.subscribe(() => {
      throw new Error('first listener broke');
    });
    wrapped.subscribe(message => {
      heard.push(message);
    });
    const frame = buildLoginResponseFrame('from-core', { kind: 'success', value: 'Success' });

    // When the core sends a frame
    core.listener?.(frame);

    // Then the second listener heard it
    expect(heard).toEqual([frame]);
  });
});
