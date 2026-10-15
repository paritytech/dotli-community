// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import type { TrUApiProductProvider } from '@parity/truapi-host';
import { bindCaptureSink } from '@dotli/metrics';
import { enableDotliDebugBuffering, onDotliDebugEvent, type DotliDebugBusEvent } from '@dotli/truapi-debug';
import { createWireDescriber, preloadWireDescriber, ownCoreConnection } from './core-connection.js';
import type { CoreConnection } from './page-core.js';
import type * as WireDescribe from './debug-wire-describe.js';
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
  it('As a dotli developer with the debug panel open, I see each frame between the product and its core with its direction', async () => {
    // Given a wrapped connection whose product side listens
    const events = openDebugPanel();
    await preloadWireDescriber();
    const core = makeProvider();
    const wrapped = ownCoreConnection(connectionOver(core).connection);
    const toProduct: Uint8Array[] = [];
    wrapped.subscribe(message => {
      toProduct.push(message);
    });
    const request = loginResponseFrame('from-product', { success: true, value: 'Success' });
    const answer = loginResponseFrame('from-core', { success: true, value: 'Success' });

    // When the product sends a frame and the core answers
    wrapped.postMessage(request);
    core.listener?.(answer);
    await Promise.resolve();

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
    await preloadWireDescriber();
    const core = makeProvider();
    const { connection, close } = connectionOver(core);
    const wrapped = ownCoreConnection(connection);

    // When it is disposed, then frames still arrive from either side
    wrapped.dispose();
    wrapped.postMessage(loginResponseFrame('late-product', { success: true, value: 'Success' }));
    core.listener?.(loginResponseFrame('late-core', { success: true, value: 'Success' }));
    await Promise.resolve();

    // Then nothing is forwarded or shown, and the connection closed as a deliberate close
    expect(events).toEqual([]);
    expect(core.postMessage).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('As a developer in debug mode, two frames reach the panel in the order they crossed', async () => {
    // Given a wrapped connection with the debug panel open
    const events = openDebugPanel();
    await preloadWireDescriber();
    const core = makeProvider();
    const wrapped = ownCoreConnection(connectionOver(core).connection);

    // When two frames cross back to back
    wrapped.postMessage(loginResponseFrame('first', { success: true, value: 'Success' }));
    wrapped.postMessage(loginResponseFrame('second', { success: true, value: 'Success' }));
    await Promise.resolve();

    // Then the panel sees them in the order they crossed
    expect(events.map(event => ('requestId' in event ? event.requestId : null))).toEqual(['first', 'second']);
  });
});

describe('wire describer', () => {
  function captureReports(): { expected: Mock } {
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    return captures;
  }

  it('As a developer in debug mode, a describer that cannot load is counted once, however many frames wait on it', async () => {
    // Given a describer whose chunk is gone
    const captures = captureReports();
    const load = vi.fn(() => Promise.reject<typeof WireDescribe>(new Error('chunk missing')));
    const describer = createWireDescriber(load);

    // When three frames wait on it
    for (let frame = 0; frame < 3; frame += 1) {
      await describer.preload().catch(() => undefined);
    }

    // Then the chunk is fetched and the miss counted once
    expect(load).toHaveBeenCalledOnce();
    expect(captures.expected).toHaveBeenCalledOnce();
    expect(captures.expected).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ step: 'wire_describe_load' }),
    );
  });

  it('As a developer in debug mode, the describer loads once for every frame', async () => {
    // Given a describer whose chunk loads
    const module = { describeWireFrame: vi.fn() } as unknown as typeof WireDescribe;
    const load = vi.fn(() => Promise.resolve(module));
    const describer = createWireDescriber(load);

    // When three frames wait on it
    const loaded = await Promise.all([describer.preload(), describer.preload(), describer.preload()]);

    // Then the chunk is fetched once and every frame gets the same module
    expect(load).toHaveBeenCalledOnce();
    expect(loaded).toEqual([module, module, module]);
  });

  it('As a second listener of the core connection, I still hear it when the first listener throws', () => {
    // Given a first listener that throws and a second that collects
    onTestFinished(bindCaptureSink({ exception: vi.fn(), expected: vi.fn() }));
    const core = makeProvider();
    const wrapped = ownCoreConnection(connectionOver(core).connection);
    const heard: Uint8Array[] = [];
    wrapped.subscribe(() => {
      throw new Error('first listener broke');
    });
    wrapped.subscribe(message => {
      heard.push(message);
    });
    const frame = loginResponseFrame('from-core', { success: true, value: 'Success' });

    // When the core sends a frame
    core.listener?.(frame);

    // Then the second listener heard it
    expect(heard).toEqual([frame]);
  });
});
