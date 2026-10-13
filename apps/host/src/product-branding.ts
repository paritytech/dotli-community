// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The product's name, icon and version from its manifests. Applied after the product renders, so it never blocks
// first paint.

import { log } from '@dotli/shared';
import { setActiveAppManifest, setActiveRootManifest } from '@dotli/host-runtime';
import { withActiveTld } from '@dotli/config';
import { showProductTitle } from './product-title.js';
import type { ProductManifests } from './manifest-gate.js';

const resolveLog = log.child({ flow: 'resolve' });

const ICON_FETCH_BUDGET_MS = 10_000;

export interface ProductBrandingDeps {
  /** Reads one block of the product's content, abandoned when the signal aborts. */
  fetchBlock: (cid: string, signal: AbortSignal) => Promise<Uint8Array>;
  /** Names the tab. The page's title by default. */
  showTitle?: typeof showProductTitle;
  /** Shows the icon in the tab. The page's `<link rel=icon>` by default. */
  setFavicon?: (href: string, format: 'jpeg' | 'png') => void;
}

/** Cosmetic: a manifest or icon that fails leaves the tab as it was and never affects the app. */
export async function applyProductBranding(
  label: string,
  { root: rootResult, app: appResult }: ProductManifests,
  { fetchBlock, showTitle = showProductTitle, setFavicon = setPageFavicon }: ProductBrandingDeps,
): Promise<void> {
  if (rootResult.kind === 'ok') {
    const root = rootResult.value;
    setActiveRootManifest({
      schemaVersion: root.$v,
      displayName: root.displayName,
      description: root.description,
      icon: root.icon,
    });
    showTitle({ mode: 'subdomain', label });
    // Cosmetic, so a short budget: a missing icon must not hold smoldot request slots the content needs.
    const format: string = root.icon.format;
    // Any other format keeps the default icon, never sniffed or corrected, and the product stays launchable.
    if (format === 'jpeg' || format === 'png') {
      const iconAborter = new AbortController();
      const iconDeadline = setTimeout(() => {
        iconAborter.abort();
      }, ICON_FETCH_BUDGET_MS);
      try {
        const bytes = await fetchBlock(root.icon.cid, iconAborter.signal);
        const blob = new Blob([new Uint8Array(bytes)], { type: `image/${format}` });
        setFavicon(URL.createObjectURL(blob), format);
        // Cosmetic: a failure must not affect the tab title or the app.
      } catch (err: unknown) {
        resolveLog.warn(`[dot.li manifest] icon fetch failed for ${withActiveTld(label)}:`, err);
      } finally {
        clearTimeout(iconDeadline);
      }
    }
  }
  if (appResult.kind === 'ok' && appResult.value.kind === 'app') {
    setActiveAppManifest({ schemaVersion: appResult.value.$v, appVersion: appResult.value.appVersion });
  }
}

function setPageFavicon(href: string, format: 'jpeg' | 'png'): void {
  const existing = document.querySelector<HTMLLinkElement>("link[rel='icon']");
  const link = existing ?? document.createElement('link');
  link.rel = 'icon';
  link.type = `image/${format}`;
  link.href = href;
  if (existing === null) {
    document.head.appendChild(link);
  }
}
