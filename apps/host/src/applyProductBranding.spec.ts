// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { bindReports } from './testing/bindReports.js';
import type { ExecutableManifest, ManifestResult, RootManifest } from '@dotli/resolver';
import { createManualTimers } from '@dotli/shared/testing';
import { applyProductBranding } from './applyProductBranding.js';

/** The tab, as far as branding writes it: the icon formats it was given. */
type Tab = {
  favicons: string[];
  hrefs: string[];
  setFavicon: (href: string, format: string) => void;
};

const APP: ManifestResult<ExecutableManifest> = {
  kind: 'ok',
  value: { $v: 1, kind: 'app', appVersion: [1, 2, 3] },
  raw: '{}',
};

describe('applyProductBranding', () => {
  it('As a visitor, I open an app with a PNG icon and see it as the favicon', async () => {
    // Given
    const tab = createTab();
    const shown: string[] = [];
    const fetchBlock = vi.fn(() => Promise.resolve(new Uint8Array([137, 80, 78, 71])));

    // When
    await applyProductBranding({
      label: 'doom',
      manifests: { root: createRootManifest('png'), app: APP },
      fetchBlock,
      setFavicon: tab.setFavicon,
      showIcon: href => shown.push(href),
    });

    // Then the card is shown the same icon as the tab
    expect(fetchBlock).toHaveBeenCalledWith('bafy-icon', expect.any(AbortSignal));
    expect(tab.favicons).toEqual(['image/png']);
    expect(shown).toEqual(tab.hrefs);
    expect(shown).toHaveLength(1);
  });

  it("As a visitor, I see no icon in the card when the product's icon fails to load", async () => {
    // Given a tab and a card, and an icon fetch that fails
    const tab = createTab();
    const shown: string[] = [];

    // When the product's icon is applied
    await applyProductBranding({
      label: 'doom',
      manifests: { root: createRootManifest('png'), app: APP },
      fetchBlock: () => Promise.reject(new TypeError('Failed to fetch')),
      setFavicon: tab.setFavicon,
      showIcon: href => shown.push(href),
    });

    // Then the card is shown no icon
    expect(shown).toEqual([]);
  });

  it('As a visitor, I open an app whose icon is in a format the host does not show and keep the default icon', async () => {
    // Given
    const tab = createTab();
    const fetchBlock = vi.fn(() => Promise.resolve(new Uint8Array()));

    // When
    await applyProductBranding({
      label: 'doom',
      manifests: { root: createRootManifest('webp'), app: APP },
      fetchBlock,
      setFavicon: tab.setFavicon,
    });

    // Then
    expect(fetchBlock).not.toHaveBeenCalled();
    expect(tab.favicons).toEqual([]);
  });

  it('As a visitor, I wait past the icon budget and keep the default icon while the icon read is abandoned', async () => {
    // Given
    const tab = createTab();
    const timers = createManualTimers();
    let abandoned = false;
    function fetchBlock(_cid: string, signal: AbortSignal): Promise<Uint8Array> {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          abandoned = true;
          reject(new Error('aborted'));
        });
      });
    }

    // When
    const branding = applyProductBranding({
      label: 'doom',
      manifests: { root: createRootManifest('jpeg'), app: APP },
      fetchBlock,
      setFavicon: tab.setFavicon,
      timers,
    });
    await timers.advance(10_000);
    await branding;

    // Then
    expect(abandoned).toBe(true);
    expect(tab.favicons).toEqual([]);
  });

  it('As an operator, I watch an icon read fail and it is counted as expected under the icon metric', async () => {
    // Given an icon read that fails
    const { captures, counted } = bindReports();
    const tab = createTab();

    // When the product's icon is applied
    await applyProductBranding({
      label: 'doom',
      manifests: { root: createRootManifest('png'), app: APP },
      fetchBlock: () => Promise.reject(new TypeError('Failed to fetch')),
      setFavicon: tab.setFavicon,
    });

    // Then the failure is counted under the icon metric and nothing is captured as an exception
    expect(counted('product.icon')).toEqual([{ outcome: 'error', reason: 'TypeError' }]);
    expect(captures.exception).not.toHaveBeenCalled();
    expect(tab.favicons).toEqual([]);
  });

  it('As a visitor on an app with no manifests, I open it and keep the default icon', async () => {
    // Given
    const tab = createTab();
    const fetchBlock = vi.fn(() => Promise.reject(new Error('unused')));

    // When
    await applyProductBranding({
      label: 'doom',
      manifests: { root: { kind: 'empty' }, app: { kind: 'empty' } },
      fetchBlock,
      setFavicon: tab.setFavicon,
    });

    // Then
    expect(tab.favicons).toEqual([]);
    expect(fetchBlock).not.toHaveBeenCalled();
  });
});

function createRootManifest(format: string): ManifestResult<RootManifest> {
  const value: RootManifest = {
    $v: 1,
    displayName: 'Doom',
    description: 'Rip and tear',
    icon: { cid: 'bafy-icon', format },
  };
  return { kind: 'ok', value, raw: JSON.stringify(value) };
}

/** Builds a tab that records the icon formats it is given. */
function createTab(): Tab {
  const favicons: string[] = [];
  const hrefs: string[] = [];
  return {
    favicons,
    hrefs,
    setFavicon(href, format) {
      hrefs.push(href);
      favicons.push(`image/${format}`);
    },
  };
}
