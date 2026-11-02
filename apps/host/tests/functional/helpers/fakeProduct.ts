// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A product the shell renders by URL, through the web container preview route that release builds keep. Nothing
// resolves and no content loads, so the test drives the product frame and the page core alone.

import type { Page } from '@playwright/test';
import { PORT } from '../../env.js';
import { seedBackend } from '../fixtures/settings.js';

/** A web container host, which the preview route accepts in every build. */
export const PREVIEW_PRODUCT_ORIGIN = 'https://e2e-product.webcontainer-api.io';

export type PreviewProduct = {
  /** The shell page that shows the product. */
  shellUrl: string;
  /** Every URL the product frame loaded, in order. */
  documents: string[];
};

/**
 * Serves a stub page for the product and counts its document loads. Seeds the gateway backend, whose protocol frame
 * opens no socket until a chain is asked for.
 */
export async function servePreviewProduct(page: Page, productPath = '/'): Promise<PreviewProduct> {
  await seedBackend(page, 'rpc-gateway');
  const documents: string[] = [];
  await page.route(`${PREVIEW_PRODUCT_ORIGIN}/**`, async route => {
    if (route.request().resourceType() === 'document') {
      documents.push(route.request().url());
    }
    await route.fulfill({
      contentType: 'text/html',
      body: '<!DOCTYPE html><html><body><main data-testid="e2e-product">preview</main></body></html>',
    });
  });
  const target = `${PREVIEW_PRODUCT_ORIGIN}${productPath}`;
  return {
    shellUrl: `http://localhost:${PORT}/__preview?url=${encodeURIComponent(target)}`,
    documents,
  };
}
