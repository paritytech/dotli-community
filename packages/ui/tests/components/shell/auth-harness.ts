// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The real auth controller, started once per file: its window listeners have no disposer, and
// reloading its module would load a second Solid.

import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest';
import { flush } from 'solid-js';
import { closeAuthModal, initAuthController } from '../../../src/auth-controller.js';
import { createBlockingModalCoordinator, type BlockingModalCoordinator } from '../../../src/blocking-modal-queue.js';
import { setAuthState } from '../../../src/state/auth.js';
import { resetStores } from '../../helpers/solid.js';
import { byId, byTestId } from '../../support.js';

let controllerListeners: Parameters<typeof window.removeEventListener>[] = [];
let events = new AbortController();

export const coordinator: BlockingModalCoordinator = createBlockingModalCoordinator();

/**
 * Starts the auth controller for this file, with boot having found no saved session before each test, and resets the
 * modal, stores and recorders after each test.
 */
export function useAuthController(): void {
  beforeAll(() => {
    const spy = vi.spyOn(window, 'addEventListener');
    initAuthController(coordinator);
    controllerListeners = spy.mock.calls.map(([type, listener]) => [type, listener]);
    spy.mockRestore();
  });

  beforeEach(() => {
    setAuthState({ tag: 'Disconnected' });
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

export function expectQrSpinnerView(): void {
  const qrBox = byId('auth-modal-qr');
  byTestId('auth-modal-spinner', qrBox);
  expect(qrBox.childElementCount).toBe(1);
  expect(qrBox.querySelector('canvas')).toBeNull();
}
