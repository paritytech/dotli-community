// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureModeStorage } from '@dotli/config';
import { memoryModeStorage } from '@dotli/config/testing';
import type { ExecutableManifest, ManifestResult, RootManifest } from '@dotli/resolver';
import {
  getActiveAppManifest,
  getActiveRootManifest,
  setActiveAppManifest,
  setActiveRootManifest,
} from '@dotli/host-runtime';
import { applyProductBranding as applyOnPage, type ProductBrandingDeps } from './product-branding.js';

function rootManifest(format: string): ManifestResult<RootManifest> {
  const value = {
    $v: 1,
    displayName: 'Doom',
    description: 'Rip and tear',
    icon: { cid: 'bafy-icon', format },
  } as RootManifest;
  return { kind: 'ok', value, raw: JSON.stringify(value) };
}

const APP: ManifestResult<ExecutableManifest> = {
  kind: 'ok',
  value: { $v: 1, kind: 'app', appVersion: [1, 2, 3] },
  raw: '{}',
};

/** The tab, as far as branding writes it: the title it shows and the icon formats it was given. */
interface Tab {
  title: string;
  favicons: string[];
}

let tab: Tab;

/** Brands the tab, which names itself from the root manifest in force when the title is shown. */
function applyProductBranding(
  label: string,
  manifests: Parameters<typeof applyOnPage>[1],
  { fetchBlock }: Pick<ProductBrandingDeps, 'fetchBlock'>,
): Promise<void> {
  return applyOnPage(label, manifests, {
    fetchBlock,
    showTitle: product => {
      tab.title = getActiveRootManifest()?.displayName ?? product.label;
    },
    setFavicon: (_href, format) => {
      tab.favicons.push(`image/${format}`);
    },
  });
}

// Settings come from a memory store, not Node's localStorage, and the previous store is put back after each test.
beforeEach(() => configureModeStorage(memoryModeStorage()));

describe('applyProductBranding', () => {
  beforeEach(() => {
    tab = { title: 'doom.dot', favicons: [] };
  });

  afterEach(() => {
    vi.useRealTimers();
    setActiveRootManifest(null);
    setActiveAppManifest(null);
  });

  it("As a visitor, I see the app's name in the tab, its icon as the favicon and its version on record", async () => {
    // Given
    const fetchBlock = vi.fn(() => Promise.resolve(new Uint8Array([137, 80, 78, 71])));

    // When
    await applyProductBranding('doom', { root: rootManifest('png'), app: APP }, { fetchBlock });

    // Then
    expect(tab.title).toBe('Doom');
    expect(getActiveRootManifest()?.displayName).toBe('Doom');
    expect(getActiveAppManifest()?.appVersion).toEqual([1, 2, 3]);
    expect(fetchBlock).toHaveBeenCalledWith('bafy-icon', expect.any(AbortSignal));
    expect(tab.favicons).toEqual(['image/png']);
  });

  it('As a visitor, I keep the default icon when the app publishes one in a format the host does not show', async () => {
    // Given
    const fetchBlock = vi.fn(() => Promise.resolve(new Uint8Array()));

    // When
    await applyProductBranding('doom', { root: rootManifest('webp'), app: APP }, { fetchBlock });

    // Then
    expect(tab.title).toBe('Doom');
    expect(fetchBlock).not.toHaveBeenCalled();
    expect(tab.favicons).toEqual([]);
  });

  it('As a visitor, I keep the name in the tab when the icon never arrives, and the icon read is abandoned', async () => {
    // Given
    vi.useFakeTimers();
    let abandoned = false;
    const fetchBlock = (_cid: string, signal: AbortSignal): Promise<Uint8Array> =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          abandoned = true;
          reject(new Error('aborted'));
        });
      });

    // When
    const branding = applyProductBranding('doom', { root: rootManifest('jpeg'), app: APP }, { fetchBlock });
    await vi.advanceTimersByTimeAsync(10_000);
    await branding;

    // Then
    expect(abandoned).toBe(true);
    expect(tab.title).toBe('Doom');
    expect(tab.favicons).toEqual([]);
  });

  it('As a visitor on an app with no manifests, I keep the tab as it was', async () => {
    // When
    await applyProductBranding(
      'doom',
      { root: { kind: 'empty' }, app: { kind: 'empty' } },
      { fetchBlock: () => Promise.reject(new Error('unused')) },
    );

    // Then
    expect(tab.title).toBe('doom.dot');
    expect(getActiveRootManifest()).toBeNull();
  });
});
