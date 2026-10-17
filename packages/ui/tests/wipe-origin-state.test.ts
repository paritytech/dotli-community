// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

describe('full reset', () => {
  beforeEach(() => {
    // Import after each reset: receiving authority and settings are module-scoped.
    vi.resetModules();
    localStorage.clear();
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubEnv('VITE_RECEIVING_RELAY_URL', '');
    vi.stubEnv('VITE_RECEIVING_PUSH_ORIGIN', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('As a dotli user, resetting my settings keeps the colour scheme I chose', async () => {
    // Given
    localStorage.setItem('dotli-theme', 'light');
    localStorage.setItem('dotli:network', 'paseo');
    const { wipeOriginState } = await import('../src/settings-actions.js');

    // When
    await wipeOriginState();

    // Then
    // The wipe preserves this now, so callers no longer snapshot it themselves.
    expect(localStorage.getItem('dotli-theme')).toBe('light');
    expect(localStorage.getItem('dotli:network')).toBeNull();
  });

  it('As a dotli user who never picked a theme, the reset does not invent one', async () => {
    // Given
    localStorage.setItem('dotli:network', 'paseo');
    const { wipeOriginState } = await import('../src/settings-actions.js');

    // When
    await wipeOriginState();

    // Then
    expect(localStorage.getItem('dotli-theme')).toBeNull();
    expect(localStorage.getItem('dotli:network')).toBeNull();
  });

  it('resets an unrelated product origin when receiving is configured for another host', async () => {
    vi.stubEnv('VITE_RECEIVING_RELAY_URL', 'https://receiver.example/__receiving');
    vi.stubEnv('VITE_RECEIVING_PUSH_ORIGIN', 'https://receiver.example');
    localStorage.setItem('dotli-theme', 'light');
    localStorage.setItem('dotli:network', 'paseo');
    const { wipeOriginState } = await import('../src/settings-actions.js');

    await wipeOriginState();

    expect(localStorage.getItem('dotli-theme')).toBe('light');
    expect(localStorage.getItem('dotli:network')).toBeNull();
  });

  it('preserves origin state when retained receiving data belongs to a removed configuration', async () => {
    localStorage.setItem('dotli:network', 'paseo');
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('truapi-browser-receiving');
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => {
        reject(new Error('Could not initialize retained receiving state', { cause: request.error }));
      };
    });
    const { wipeOriginState } = await import('../src/settings-actions.js');

    await expect(wipeOriginState()).rejects.toThrow();

    expect(localStorage.getItem('dotli:network')).toBe('paseo');
    expect(await indexedDB.databases()).toEqual([expect.objectContaining({ name: 'truapi-browser-receiving' })]);
  });
});
