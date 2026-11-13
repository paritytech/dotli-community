// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The product id a product asks the core for. The core parses it into the id the product runs under.

import { withActiveTld } from '@dotli/config';
import type { PageProduct } from './createPageCore.js';

/** The product id a product asks for: the one it names, else the one its label derives. Never throws. */
export function getAskedProductId({ label, productId }: Pick<PageProduct, 'label' | 'productId'>): string {
  return productId ?? toProductId(label);
}

/**
 * The product id `label` asks for: a local label as it is, any other under the active TLD. Never throws. The window
 * origin deliberately plays no part in it.
 */
export function toProductId(label: string): string {
  return label.startsWith('localhost:') ? label : withActiveTld(label);
}
