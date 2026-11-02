// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getNetwork } from './activeNetwork.js';
import { setSettings } from './activeSettings.js';
import { getBackend } from './backend.js';
import { getCacheSettings } from './cacheSettings.js';
import type { Network } from './networkNames.js';
import type { Settings } from './resolveSettings.js';

/** Sets the network this context runs on. A context that only reads the link's network has no other setting to give. */
export function setActiveNetwork(network: Network): void {
  setSettings({ ...getSettings(), network });
}

/** This context's settings, each the default until set. */
export function getSettings(): Settings {
  return { network: getNetwork(), backend: getBackend(), cache: getCacheSettings() };
}
