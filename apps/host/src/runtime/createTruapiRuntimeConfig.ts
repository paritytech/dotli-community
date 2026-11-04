// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getActiveServicesConfig, withActiveTld } from '@dotli/config';
import type { WebWorkerHostConfig } from '@parity/truapi-host/web';

type GetPlatformTypeParams = {
  /** The browser's user agent string, the page's when left out. */
  userAgent?: string;
};

// A build-time define, so undefined in tests and other bundles.
declare const __DOTLI_VERSION__: string | undefined;

/**
 * The host config a product's core boots with. Never throws. It names no product, since the core parses the product id
 * itself once it is up.
 */
export function createTruapiRuntimeConfig(): WebWorkerHostConfig {
  const config: WebWorkerHostConfig = {
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

/**
 * The product id `label` asks for: a local label as it is, any other under the active TLD. Never throws. The core
 * parses it into the id the product runs under. The window origin deliberately plays no part in it.
 */
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
