// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Env overrides shared by every host test suite.
 *
 * Centralised so a single env change propagates everywhere. Tests
 * import these instead of re-reading `process.env`.
 */

import {
  NETWORK_NAME_TO_SERVICES_CONFIG,
  isValidNetwork,
  type Network,
} from "@dotli/config/network";

export const DOMAIN = process.env.DOMAIN ?? "host-playground";
export const PORT = process.env.PORT ?? "5173";
export const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS ?? "45000", 10);

/** Network under test. Must match the first entry of the build's VITE_NETWORKS. */
export const NETWORK: Network = (() => {
  const raw = process.env.NETWORK ?? "paseo-next-v2";
  if (!isValidNetwork(raw)) {
    throw new Error(`NETWORK is not a known network: ${JSON.stringify(raw)}`);
  }
  return raw;
})();

/** dotNS suffix of the network under test, e.g. `.paseo`. Read from the same config the app uses. */
export const TLD_SUFFIX = `.${NETWORK_NAME_TO_SERVICES_CONFIG[NETWORK].dotns.TLD}`;

/** The full dotNS name under test, e.g. `host-playground.paseo`. */
export const DOTNS_NAME = `${DOMAIN}${TLD_SUFFIX}`;
