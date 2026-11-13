// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { SITE_ID, withActiveTld } from '@dotli/config';
import type { TitledProduct } from './runtime/createProductFrame.js';

/** The tab title for a product, preferring the display name its root manifest publishes. */
export function getProductTitle(product: TitledProduct): string {
  switch (product.mode) {
    case 'iframe':
      return `${product.label} · ${SITE_ID}`;
    case 'subdomain':
      return product.displayName ?? withActiveTld(product.label);
  }
}
