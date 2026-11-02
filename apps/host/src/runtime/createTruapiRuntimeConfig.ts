// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getActiveServicesConfig, withActiveTld } from '@dotli/config';
import type { ProductRuntimeConfig } from '@parity/truapi-host';

type Params = {
  /** The product id the core runs under, `label`'s own when left out. */
  productId?: string | undefined;
};

type GetPlatformTypeParams = {
  /** The browser's user agent string, the page's when left out. */
  userAgent?: string;
};

// A build-time define, so undefined in tests and other bundles.
declare const __DOTLI_VERSION__: string | undefined;

/**
 * The runtime config a product's core boots with, for `label` under `productId`. Never throws. The window origin
 * deliberately plays no part in `productId`.
 */
export function createTruapiRuntimeConfig(
  label: string,
  { productId = toProductId(label) }: Params = {},
): ProductRuntimeConfig {
  const config: ProductRuntimeConfig = {
    productId,
    host: {
      name: 'Polkadot Web',
      ...(typeof __DOTLI_VERSION__ === 'string' ? { version: __DOTLI_VERSION__ } : {}),
    },
    platform: {
      type: getPlatformType(),
    },
    people: {
      genesisHash: getActiveServicesConfig().people.genesis,
    },
    bulletin: {
      genesisHash: getActiveServicesConfig().bulletin.genesis,
    },
    assetHub: {
      genesisHash: getActiveServicesConfig().assethub.genesis,
    },
    pairing: {
      deeplinkScheme: 'polkadotapp',
    },
  };
  return config;
}

/** The release the build descends from, or `0.0.0` in a build that names none. */
export function getDotliVersion(): string {
  return typeof __DOTLI_VERSION__ === 'string' ? __DOTLI_VERSION__ : '0.0.0';
}

/** The product id of `label`: a local label as it is, any other under the active TLD. Never throws. */
export function toProductId(label: string): string {
  return label.startsWith('localhost:') ? label : withActiveTld(label);
}

function getPlatformType({ userAgent = navigator.userAgent }: GetPlatformTypeParams = {}): string {
  if (userAgent.includes('Win')) {
    return 'Windows';
  }
  if (userAgent.includes('Mac')) {
    return 'macOS';
  }
  if (userAgent.includes('Linux')) {
    return 'Linux';
  }
  return 'Unknown';
}
