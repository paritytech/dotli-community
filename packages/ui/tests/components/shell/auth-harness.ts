// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Shared setup for the auth islands' tests: the real auth controller, started
// once per file (its window listeners have no disposer, and reloading its
// module would load a second Solid), and window event recorders that go away
// after each test.

import { afterAll, afterEach, beforeAll, expect, vi } from 'vitest';
import { flush } from 'solid-js';
import { closeAuthModal, initAuthController } from '../../../src/auth-controller.js';
import { createBlockingModalCoordinator, type BlockingModalCoordinator } from '../../../src/blocking-modal-queue.js';
import { resetStores } from '../../helpers/solid.js';
import { byId, byTestId } from '../../support.js';

let controllerListeners: Parameters<typeof window.removeEventListener>[] = [];
let events = new AbortController();

/** The coordinator the controller holds its modal lease through. */
export const coordinator: BlockingModalCoordinator = createBlockingModalCoordinator();

/**
 * Start the auth controller for this file, and after each test close the
 * modal (releasing its lease), reset the stores and drop the recorders.
 */
export function useAuthController(): void {
  beforeAll(() => {
    const spy = vi.spyOn(window, 'addEventListener');
    initAuthController(coordinator);
    controllerListeners = spy.mock.calls.map(([type, listener]) => [type, listener]);
    spy.mockRestore();
  });

  afterEach(() => {
    events.abort();
    events = new AbortController();
    closeAuthModal({ skipTruapiCancel: true });
    resetStores();
  });

  afterAll(() => {
    for (const [type, listener] of controllerListeners) {
      window.removeEventListener(type, listener);
    }
  });
}

/** Records window events named `name` until the test ends. */
export function recordEvents(name: string): { details: unknown[] } {
  const seen = { details: [] as unknown[] };
  window.addEventListener(
    name,
    event => {
      seen.details.push((event as CustomEvent).detail);
    },
    { signal: events.signal },
  );
  return seen;
}

/** Let the lease's queued task run and Solid apply what it wrote. */
export async function settleAll(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    flush();
    await Promise.resolve();
  }
  flush();
}

export function press(
  key: string,
  init: KeyboardEventInit = {},
  target: EventTarget = document.activeElement ?? document,
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

export { byId };

/** The pairing modal's QR container holds the spinner and no canvas. */
export function expectQrSpinnerView(): void {
  const qrBox = byId('auth-modal-qr');
  byTestId('auth-modal-spinner', qrBox);
  expect(qrBox.querySelector('canvas')).toBeNull();
}
