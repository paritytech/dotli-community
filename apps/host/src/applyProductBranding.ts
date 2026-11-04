// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The product's icon from its root manifest. Applied after the product renders, so it never blocks first paint.

import { reportExpected, spans as S } from '@dotli/metrics';
import { log, realTimers, type Timers } from '@dotli/shared';
import { withActiveTld } from '@dotli/config';
import type { ProductManifests } from './cachedManifest.js';
import { productCardState } from './state/productCardState.js';

type Params = {
  /** The product's label, named in the report of a failed icon. */
  label: string;
  /** The product's manifests, whose root names the icon. */
  manifests: ProductManifests;
  /** Reads one block of the product's content, abandoned when the signal aborts. Rejects when the read fails. */
  fetchBlock: (cid: string, signal: AbortSignal) => Promise<Uint8Array>;
  /** Shows the icon in the tab. The page's `<link rel=icon>` by default. */
  setFavicon?: (href: string, format: 'jpeg' | 'png') => void;
  /** Shows the icon in the product card. The page's product card state by default. */
  showIcon?: (href: string) => void;
  /** The timers the icon's budget runs on. The page's own by default. */
  timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
};

const resolveLog = log.createChild({ flow: 'resolve' });

const ICON_FETCH_BUDGET_MS = 10_000;

/**
 * Shows the product's icon in the tab and the product card. Cosmetic: never rejects, and an icon that fails leaves the
 * tab and the card as they were.
 */
export async function applyProductBranding({
  label,
  manifests,
  fetchBlock,
  setFavicon = setPageFavicon,
  showIcon = productCardState.setIcon,
  timers = realTimers,
}: Params): Promise<void> {
  const rootResult = manifests.root;
  if (rootResult.kind !== 'ok') {
    return;
  }
  // Cosmetic, so a short budget: a missing icon must not hold smoldot request slots the content needs.
  const format: string = rootResult.value.icon.format;
  // Any other format keeps the default icon, never sniffed or corrected, and the product stays launchable.
  if (format !== 'jpeg' && format !== 'png') {
    return;
  }
  const iconAborter = new AbortController();
  const iconDeadline = timers.setTimeout(() => {
    iconAborter.abort();
  }, ICON_FETCH_BUDGET_MS);
  try {
    const bytes = await fetchBlock(rootResult.value.icon.cid, iconAborter.signal);
    const blob = new Blob([new Uint8Array(bytes)], { type: `image/${format}` });
    const href = URL.createObjectURL(blob);
    setFavicon(href, format);
    showIcon(href);
  } catch (error: unknown) {
    // Cosmetic: a failure must not affect the app, so the tab keeps its icon.
    resolveLog.warn(`[dot.li manifest] icon fetch failed for ${withActiveTld(label)}:`, error);
    // Warned through the resolve logger, so the report writes no line of its own.
    reportExpected(error, { flow: 'resolve', step: 'product_icon', metric: S.PRODUCT_ICON });
  } finally {
    timers.clearTimeout(iconDeadline);
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
