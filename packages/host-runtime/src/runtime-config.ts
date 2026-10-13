// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getActiveServicesConfig, withActiveTld } from '@dotli/config';
import type { ProductRuntimeConfig } from '@parity/truapi-host';

// Defined by `apps/host/astro.config.ts`, so undefined in tests and other bundles.
declare const __DOTLI_VERSION__: string | undefined;

/** The release the build descends from. */
export function dotliVersion(): string {
  return typeof __DOTLI_VERSION__ === 'string' ? __DOTLI_VERSION__ : '0.0.0';
}

export function labelToProductId(label: string): string {
  return label.startsWith('localhost:') ? label : withActiveTld(label);
}

function getPlatformType(userAgent: string = navigator.userAgent): string {
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

// The window origin deliberately plays no part in `productId`.
export function createTruapiRuntimeConfig(
  label: string,
  productId: string = labelToProductId(label),
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
