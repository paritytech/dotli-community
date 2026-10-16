// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// From its source file: the `@dotli/config` barrel reads `self.location` and `import.meta.env` at load, so Node
// cannot load it.
import {
  NETWORK_NAME_TO_SERVICES_CONFIG,
  NetworkName,
  isValidNetwork,
  type Network,
} from '../../../packages/config/src/network.js';

export const DOMAIN = process.env['DOMAIN'] ?? 'host-playground';
/** The functional config starts one preview server per worker. */
export const PORT = process.env['PORT'] ?? String(5173 + Number(process.env['TEST_PARALLEL_INDEX'] ?? '0'));
export const TIMEOUT_MS = parseInt(process.env['TIMEOUT_MS'] ?? '45000', 10);

/** Must match the first entry of the build's VITE_NETWORKS. */
export const NETWORK: Network = (() => {
  const raw = process.env['NETWORK'] ?? NetworkName.PASEO;
  if (!isValidNetwork(raw)) {
    throw new Error(`NETWORK is not a known network: ${JSON.stringify(raw)}`);
  }
  return raw;
})();

export const TLD_SUFFIX = `.${NETWORK_NAME_TO_SERVICES_CONFIG[NETWORK].dotns.TLD}`;

export const DOTNS_NAME = `${DOMAIN}${TLD_SUFFIX}`;
