// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A panel that throws while rendering after it mounted must dispose itself and leave the page, not stay frozen.

import { bindCaptureSink } from '@dotli/metrics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal, flush, onCleanup } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { untilDom } from '@dotli/shared/testing';
import { setupTruapiDebugPanel } from '../src/truapi-debug-panel.js';
import { PANEL_ID } from '../src/Panel.js';
import { fakeDebugPanelHost } from '../src/host.fake.js';

const captures = { exception: vi.fn(), expected: vi.fn() };
bindCaptureSink(captures);

/** What the stand-in view did, and how to make it throw later. */
const view = {
  breakLater: null as (() => void) | null,
  disposed: 0,
  ticks: 0,
};

/** A stand-in view that can be made to throw later, counting its ticks. */
function lateView(id: string): () => JSX.Element {
  return () => {
    const [late, setLate] = createSignal(false, { ownedWrite: true });
    view.breakLater = () => setLate(true);
    const timer = setInterval(() => {
      view.ticks += 1;
    }, 5);
    onCleanup(() => {
      view.disposed += 1;
      clearInterval(timer);
    });
    const el = document.createElement('div');
    el.id = id;
    return [
      el,
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
  view.ticks = 0;
  captures.exception.mockClear();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.head.replaceChildren();
  document.body.replaceChildren();
});

describe('late render errors', () => {
  it('As a dotli developer, a debug panel that throws after it mounted is disposed once, leaves the page and can be set up again', async () => {
    // Given
    const panelView = lateView(PANEL_ID);
    const { host } = fakeDebugPanelHost();
    const dispose = setupTruapiDebugPanel({ host, view: panelView });
    await untilDom(() => document.getElementById(PANEL_ID) !== null);
    const panel = document.getElementById(PANEL_ID);
    expect(panel?.isConnected).toBe(true);

    // When
    view.breakLater?.();
    flush();
    await untilDom(() => panel?.isConnected === false);
    const ticks = view.ticks;
    vi.advanceTimersByTime(30);

    // Then
    expect(panel?.isConnected).toBe(false);
    expect(document.body.childElementCount).toBe(0);
    expect(view.disposed).toBe(1);
    expect(view.ticks).toBe(ticks);
    expect(captures.exception).toHaveBeenCalledTimes(1);

    // When
    dispose();
    const again = setupTruapiDebugPanel({ host, view: panelView });

    // Then
    expect(view.disposed).toBe(1);
    expect(document.getElementById(PANEL_ID)?.isConnected).toBe(true);
    again();
  });
});
