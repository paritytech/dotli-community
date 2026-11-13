// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getActiveServicesConfig } from '@dotli/config';
import type { WebWorkerHostConfig } from '@parity/truapi-host/web';
import { DOTLI_VERSION } from './getDotliVersion.js';
import { getOperatingSystem } from './getOperatingSystem.js';

/**
 * The host config a product's core boots with. Never throws. It names no product, since the core parses the product id
 * itself once it is up.
 */
export function createTruapiRuntimeConfig(): WebWorkerHostConfig {
  const services = getActiveServicesConfig();
  return {
    host: {
      name: 'Polkadot Web',
      ...(DOTLI_VERSION === null ? {} : { version: DOTLI_VERSION }),
    },
    platform: {
      type: getOperatingSystem(navigator.userAgent),
    },
    people: {
      genesisHash: services.people.genesis,
    },
    bulletin: {
      genesisHash: services.bulletin.genesis,
    },
    assetHub: {
      genesisHash: services.assethub.genesis,
    },
    pairing: {
      deeplinkScheme: 'polkadotapp',
    },
  };
}
