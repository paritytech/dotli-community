// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';

import { registerAppServiceWorker, type AppServiceWorker } from './service-worker.js';

/** A worker that answers the version check with `version`. */
function workerAt(version: string): ServiceWorker {
  return {
    postMessage: (_message: unknown, transfer: Transferable[]) => {
      const port = transfer[0] as MessagePort;
      port.postMessage({ type: 'SW_VERSION', version });
    },
  } as unknown as ServiceWorker;
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
});
