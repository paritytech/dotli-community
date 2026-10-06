// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A root that throws while rendering after it mounted must not stay behind
// frozen and still running: the sandbox checker's violation panel and the
// TrUAPI debug panel dispose themselves and leave the page.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flush } from 'solid-js';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../../../metrics/src/sentry.js', () => sentry);

/** A stand-in view that can be made to throw later, counting its ticks. */
const view = vi.hoisted(() => ({
  breakLater: null as (() => void) | null,
  disposed: 0,
  ticks: 0,
}));

async function lateView(id: string): Promise<() => unknown> {
  const { createSignal, onCleanup } = await import('solid-js');
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
      () => {
        if (late()) {
          throw new Error(`${id} broke later`);
        }
        return null;
      },
    ];
  };
}

vi.mock('../../src/components/sandbox-checker/ViolationPanel.js', async () => ({
  ViolationPanel: await lateView('sandbox-checker-panel'),
}));
vi.mock('../../src/components/truapi-debug/Panel.js', async () => ({
  PANEL_ID: 'truapi-debug-panel',
  Panel: await lateView('truapi-debug-panel'),
}));

async function settleError(): Promise<void> {
  flush();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  view.breakLater = null;
  view.disposed = 0;
  view.ticks = 0;
  sentry.captureException.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  document.head.replaceChildren();
  document.body.replaceChildren();
});

describe('late render errors', () => {
  it('As a dotli developer, a violation panel that throws after it mounted is disposed once and leaves the page', async () => {
    // Given
    const { mountViolationPanel } = await import('../../src/components/sandbox-checker/mount.js');
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const dispose = mountViolationPanel(iframe);
    await settleError();
    const panel = document.getElementById('sandbox-checker-panel');
    expect(panel?.isConnected).toBe(true);
    const containers = document.body.childElementCount;

    // When
    view.breakLater?.();
    await settleError();
    const ticks = view.ticks;
    await new Promise(resolve => setTimeout(resolve, 30));

    // Then
    expect(panel?.isConnected).toBe(false);
    expect(document.body.childElementCount).toBe(containers - 1);
    expect(view.disposed).toBe(1);
    expect(view.ticks).toBe(ticks);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);

    // When: the owner disposes it too.
    dispose();

    // Then
    expect(view.disposed).toBe(1);
  });

  it('As a dotli developer, a debug panel that throws after it mounted is disposed once, leaves the page and can be set up again', async () => {
    // Given
    const { setupTruapiDebugPanel } = await import('../../src/components/truapi-debug/mount.js');
    const dispose = setupTruapiDebugPanel();
    await settleError();
    const panel = document.getElementById('truapi-debug-panel');
    expect(panel?.isConnected).toBe(true);

    // When
    view.breakLater?.();
    await settleError();
    const ticks = view.ticks;
    await new Promise(resolve => setTimeout(resolve, 30));

    // Then
    expect(panel?.isConnected).toBe(false);
    expect(document.body.childElementCount).toBe(0);
    expect(view.disposed).toBe(1);
    expect(view.ticks).toBe(ticks);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);

    // When
    dispose();
    const again = setupTruapiDebugPanel();

    // Then
    expect(view.disposed).toBe(1);
    expect(document.getElementById('truapi-debug-panel')?.isConnected).toBe(true);
    again();
  });
});
