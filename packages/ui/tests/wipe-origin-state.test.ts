// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('full reset', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    vi.stubEnv('VITE_RECEIVING_ORIGINS', '');
    vi.stubGlobal('indexedDB', { databases: vi.fn(() => Promise.resolve([])) });
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

  it('resets an unrelated origin without borrowing another host receiving configuration', async () => {
    vi.stubEnv(
      'VITE_RECEIVING_ORIGINS',
      JSON.stringify([
        {
          origin: 'https://receiver.example',
          relayUrl: 'https://receiver.example/__receiving',
          vapidPublicKey: `B${'A'.repeat(86)}`,
        },
      ]),
    );
    localStorage.setItem('dotli-theme', 'light');
    localStorage.setItem('dotli:network', 'paseo');
    const { wipeOriginState } = await import('../src/settings-actions.js');
    await wipeOriginState();
    expect(localStorage.getItem('dotli-theme')).toBe('light');
    expect(localStorage.getItem('dotli:network')).toBeNull();
  });

  it('retains local state when receiving registrations cannot be revoked without their configuration', async () => {
    vi.stubGlobal('indexedDB', {
      databases: vi.fn(() => Promise.resolve([{ name: 'truapi-browser-receiving' }])),
    });
    localStorage.setItem('dotli:network', 'paseo');
    const { wipeOriginState } = await import('../src/settings-actions.js');
    await expect(wipeOriginState()).rejects.toThrow('Restore this host');
    expect(localStorage.getItem('dotli:network')).toBe('paseo');
  });
});
