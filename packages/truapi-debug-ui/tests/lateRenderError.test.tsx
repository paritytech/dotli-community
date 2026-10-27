// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A panel that throws while rendering after it mounted must dispose itself and leave the page, not stay frozen.

import { bindCaptureSink } from '@dotli/metrics';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createSignal, flush, onCleanup } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { waitForDom } from '@dotli/shared/testing';
import { createDebugBus } from '@dotli/truapi-debug/testing';
import { setupTruapiDebugPanel } from '../src/truapiDebugPanel.js';
import { PANEL_ID } from '../src/Panel.js';
import { fakeDebugPanelHost } from '../src/host.fake.js';

const captures = { exception: vi.fn(), expected: vi.fn() };
bindCaptureSink(captures);

/** What the stand-in view did, and how to make it throw later. */
const view: { breakLater: (() => void) | null; disposed: number } = {
  breakLater: null,
  disposed: 0,
};

/** A stand-in view that can be made to throw later. */
function createLateView(id: string): () => JSX.Element {
  return () => {
    const [late, setLate] = createSignal(false, { ownedWrite: true });
    view.breakLater = () => setLate(true);
    onCleanup(() => {
      view.disposed += 1;
    });
    const element = document.createElement('div');
    element.id = id;
    return [
      element,
      // eslint-disable-next-line solid/reactivity -- a function child is tracked by the renderer, which is the point: it throws on change.
      (): null => {
        if (late()) {
          throw new Error(`${id} broke later`);
        }
        return null;
      },
    ];
  };
}

beforeEach(() => {
  view.breakLater = null;
  view.disposed = 0;
  captures.exception.mockClear();
});

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
});

describe('late render errors', () => {
  it('As a dotli developer, I mount a debug panel that throws later and it is disposed once, stops listening to the bus, leaves the page and can be set up again', async () => {
    // Given
    const panelView = createLateView(PANEL_ID);
    const { host } = fakeDebugPanelHost();
    const bus = createDebugBus();
    bus.enableBuffering();
    const dispose = setupTruapiDebugPanel({ host, bus, view: panelView });
    await waitForDom(() => document.getElementById(PANEL_ID) !== null);
    const panel = document.getElementById(PANEL_ID);
    const connectedOnMount = panel?.isConnected;
    const listeningOnMount = bus.hasListeners();

    // When
    view.breakLater?.();
    flush();
    await waitForDom(() => panel?.isConnected === false);

    // Then
    expect(connectedOnMount).toBe(true);
    expect(listeningOnMount).toBe(true);
    expect(panel?.isConnected).toBe(false);
    expect(document.body.childElementCount).toBe(0);
    expect(view.disposed).toBe(1);
    expect(bus.hasListeners()).toBe(false);
    expect(captures.exception).toHaveBeenCalledTimes(1);

    // When
    dispose();
    onTestFinished(setupTruapiDebugPanel({ host, bus, view: panelView }));

    // Then
    expect(view.disposed).toBe(1);
    expect(document.getElementById(PANEL_ID)?.isConnected).toBe(true);
  });
});
