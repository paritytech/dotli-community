// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';

import { SANDBOX_ERRORS } from './errors.js';
import { registerAppServiceWorker, storeArchiveInSW, type AppServiceWorker } from './service-worker.js';

/** A worker that answers the version check with `version`. */
function workerAt(version: string): ServiceWorker {
  return {
    postMessage: (_message: unknown, transfer: Transferable[]) => {
      const port = transfer[0] as MessagePort;
      port.postMessage({ type: 'SW_VERSION', version });
    },
  } as unknown as ServiceWorker;
}

/** A container with no controller yet, counting the `controllerchange` listeners still attached. */
class FreshContainer extends EventTarget {
  readonly controller = null;
  readonly ready = new Promise<ServiceWorkerRegistration>(() => undefined);
  listening = 0;
  /** Resolves once something listens for `controllerchange`. */
  readonly listened: Promise<void>;
  private heard: () => void = () => undefined;

  constructor() {
    super();
    this.listened = new Promise(resolve => {
      this.heard = resolve;
    });
  }

  register(): Promise<ServiceWorkerRegistration> {
    return Promise.resolve({ active: null, update: () => Promise.resolve() } as unknown as ServiceWorkerRegistration);
  }

  override addEventListener(...args: Parameters<EventTarget['addEventListener']>): void {
    if (args[0] === 'controllerchange') {
      this.listening += 1;
      this.heard();
    }
    super.addEventListener(...args);
  }

  override removeEventListener(...args: Parameters<EventTarget['removeEventListener']>): void {
    if (args[0] === 'controllerchange') {
      this.listening -= 1;
    }
    super.removeEventListener(...args);
  }
}

describe('registerAppServiceWorker', () => {
  it('As a visitor after a deploy, an outdated service worker is updated and I am offered a reload', async () => {
    // Given a page controlled by a worker from the build before
    const active = workerAt('old-build');
    const update = vi.fn(() => Promise.resolve());
    const registration = { active, update } as unknown as ServiceWorkerRegistration;
    const container = {
      controller: active,
      register: () => Promise.resolve(registration),
    } as unknown as ServiceWorkerContainer;
    let offerReload: () => void = () => undefined;
    const offered = new Promise<void>(resolve => {
      offerReload = resolve;
    });
    const appWorker: AppServiceWorker = { container, version: 'new-build', offerReload };

    // When
    await registerAppServiceWorker(appWorker);
    await offered;

    // Then
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('As a visitor after a full reset, the wait for the fresh worker leaves no listener once it takes control', async () => {
    // Given a page whose fresh worker has not taken control yet
    const container = new FreshContainer();
    const registered = registerAppServiceWorker(
      { container: container as unknown as ServiceWorkerContainer, version: undefined, offerReload: () => undefined },
      { waitForFreshController: true },
    );
    await container.listened;

    // When the fresh worker takes control
    container.dispatchEvent(new Event('controllerchange'));
    await registered;

    // Then
    expect(container.listening).toBe(0);
  });
});

describe('storeArchiveInSW', () => {
  it('As a visitor whose service worker could not start, the load fails instead of writing a page with no files', async () => {
    // Given a page no service worker controls
    const container = { controller: null } as unknown as ServiceWorkerContainer;
    const files = { 'index.html': new Uint8Array([60]), 'app.js': new Uint8Array([59]) };

    // When
    const stored = storeArchiveInSW(container, files, '/');

    // Then
    await expect(stored).rejects.toThrow(SANDBOX_ERRORS.SW_NOT_CONTROLLING);
  });
});
