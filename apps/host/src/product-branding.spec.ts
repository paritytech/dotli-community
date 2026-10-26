// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutableManifest, ManifestResult, RootManifest } from '@dotli/resolver';
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

/** The tab, as far as branding writes it: the icon formats it was given. */
type Tab = {
  favicons: string[];
};

let tab: Tab;

/** Brands the tab, which records the icon formats it is given. */
function applyProductBranding(
  label: string,
  manifests: Parameters<typeof applyOnPage>[1],
  { fetchBlock }: Pick<ProductBrandingDeps, 'fetchBlock'>,
): Promise<void> {
  return applyOnPage(label, manifests, {
    fetchBlock,
    setFavicon: (_href, format) => {
      tab.favicons.push(`image/${format}`);
    },
  });
}

describe('applyProductBranding', () => {
  beforeEach(() => {
    tab = { favicons: [] };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("As a visitor, I see the app's icon as the favicon", async () => {
    // Given
    const fetchBlock = vi.fn(() => Promise.resolve(new Uint8Array([137, 80, 78, 71])));

    // When
    await applyProductBranding('doom', { root: rootManifest('png'), app: APP }, { fetchBlock });

    // Then
    expect(fetchBlock).toHaveBeenCalledWith('bafy-icon', expect.any(AbortSignal));
    expect(tab.favicons).toEqual(['image/png']);
  });

  it('As a visitor, I keep the default icon when the app publishes one in a format the host does not show', async () => {
    // Given
    const fetchBlock = vi.fn(() => Promise.resolve(new Uint8Array()));

    // When
    await applyProductBranding('doom', { root: rootManifest('webp'), app: APP }, { fetchBlock });

    // Then
    expect(fetchBlock).not.toHaveBeenCalled();
    expect(tab.favicons).toEqual([]);
  });

  it('As a visitor, I keep the default icon when it never arrives, and the icon read is abandoned', async () => {
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
    expect(tab.favicons).toEqual([]);
  });

  it('As a visitor on an app with no manifests, I keep the default icon', async () => {
    // Given
    const fetchBlock = vi.fn(() => Promise.reject(new Error('unused')));

    // When
    await applyProductBranding('doom', { root: { kind: 'empty' }, app: { kind: 'empty' } }, { fetchBlock });

    // Then
    expect(tab.favicons).toEqual([]);
    expect(fetchBlock).not.toHaveBeenCalled();
  });
});
