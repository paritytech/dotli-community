// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A root that throws while rendering after it mounted must dispose itself and leave the page, not stay frozen.

import { bindCaptureSink } from '@dotli/metrics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal, flush, onCleanup } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { untilDom } from '@dotli/shared/testing';
import { mountViolationPanel } from '../../../src/components/sandbox-checker/mount.js';

const captures = { exception: vi.fn(), expected: vi.fn() };
bindCaptureSink(captures);

/** What the stand-in view did, and how to make it throw later. */
const view = {
  breakLater: null as (() => void) | null,
  disposed: 0,
};

/** A stand-in view that can be made to throw later, counting its disposals. */
function lateView(id: string): () => JSX.Element {
  return () => {
    const [late, setLate] = createSignal(false, { ownedWrite: true });
    view.breakLater = () => setLate(true);
    onCleanup(() => {
      view.disposed += 1;
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
  captures.exception.mockClear();
});

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
});

describe('late render errors', () => {
  it('As a dotli developer, a violation panel that throws after it mounted is disposed once and leaves the page', async () => {
    // Given
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const dispose = mountViolationPanel(iframe, lateView('sandbox-checker-panel'));
    await untilDom(() => document.getElementById('sandbox-checker-panel') !== null);
    const panel = document.getElementById('sandbox-checker-panel');
    expect(panel?.isConnected).toBe(true);
    const containers = document.body.childElementCount;

    // When
    view.breakLater?.();
    flush();
    await untilDom(() => panel?.isConnected === false);

    // Then
    expect(panel?.isConnected).toBe(false);
    expect(document.body.childElementCount).toBe(containers - 1);
    expect(view.disposed).toBe(1);
    expect(captures.exception).toHaveBeenCalledTimes(1);

    // When: the owner disposes it too.
    dispose();

    // Then
    expect(view.disposed).toBe(1);
  });
});
