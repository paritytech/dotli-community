// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { BACKEND_KEY, CACHE_KEY, NETWORK_KEY } from '@dotli/config';
import { memoryStorage } from '@dotli/shared/testing';
import { windowSettings } from './session-settings.js';

/** What `storage` holds, to compare before and after a read. */
function contents(storage: Storage): Record<string, string | null> {
  const entries: Record<string, string | null> = {};
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key !== null) {
      entries[key] = storage.getItem(key);
    }
  }
  return entries;
}

describe('windowSettings', () => {
  it('As a user in the sign-in window, I open it on net and the network is never saved', () => {
    // Given this origin saved another network, a backend and a cache choice
    const local = memoryStorage({
      [NETWORK_KEY]: 'paseo-next-v2',
      [BACKEND_KEY]: 'rpc-gateway',
      [CACHE_KEY]: JSON.stringify({ skipCidCache: true, skipArchiveCache: false, skipWorkerCache: false }),
    });
    const before = contents(local);

    // When the window opens on net
    const settings = windowSettings('?intent=signin&net=previewnet', local, true);

    // Then the network is the link's for this window alone, the rest is this origin's, and nothing was written
    expect(settings).toEqual({
      network: 'previewnet',
      backend: 'rpc-gateway',
      cache: { skipCidCache: true, skipArchiveCache: false, skipWorkerCache: false },
    });
    expect(contents(local)).toEqual(before);
  });

  it('As a user in the sign-in window, I open it with a network name no build knows and it falls back to the stored one', () => {
    // Given a stored network
    const local = memoryStorage({ [NETWORK_KEY]: 'previewnet' });

    // When the window opens with an unknown net
    const settings = windowSettings('?intent=signin&net=nowhere', local, true);

    // Then the stored network is kept
    expect(settings.network).toBe('previewnet');
  });

  it("As a user in the sign-in window, I open it and only net is read, not the landing page's network parameter", () => {
    // Given a stored network
    const local = memoryStorage({ [NETWORK_KEY]: 'paseo-next-v2' });

    // When the window opens with the landing page's network parameter
    const settings = windowSettings('?intent=signin&network=previewnet', local, true);

    // Then the stored network is kept
    expect(settings.network).toBe('paseo-next-v2');
  });

  it("As a user in the sign-in window on a fresh origin, I open it and it runs on net, else on the build's first network", () => {
    // Given an origin with nothing stored
    const local = memoryStorage();

    // When the window opens with and without net
    const withNet = windowSettings('?intent=signin&net=previewnet', local, true);
    const withoutNet = windowSettings('?intent=signin', local, true);

    // Then it runs on net, else on the first network
    expect(withNet.network).toBe('previewnet');
    expect(withoutNet.network).toBe('paseo-next-v2');
  });

  it('As a user in the sign-in window in a browser without SharedWorker, I open it and the light client runs per tab over a stored shared one', () => {
    // Given a stored shared-worker backend
    const local = memoryStorage({ [NETWORK_KEY]: 'paseo-next-v2', [BACKEND_KEY]: 'smoldot-shared-worker' });

    // When the window opens where SharedWorker is missing
    const settings = windowSettings('?intent=signin', local, false);

    // Then the light client runs per tab
    expect(settings.backend).toBe('smoldot-direct');
  });
});
