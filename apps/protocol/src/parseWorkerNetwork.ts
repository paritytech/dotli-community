// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { isValidNetwork, type Network } from '@dotli/config/fixed';
import { err, ok, type ResultPayload } from '@dotli/transport';

/** The network a worker serves, or why it cannot serve one. */
export type WorkerNetwork = ResultPayload<Network, string>;

const NETWORK_NAME_PREFIX = 'dotli-protocol-';

/** The network a worker's name carries, or why it carries none. A worker's URL cannot carry it. Never throws. */
export function parseWorkerNetwork(name: string): WorkerNetwork {
  const requested = name.slice(NETWORK_NAME_PREFIX.length);
  if (!name.startsWith(NETWORK_NAME_PREFIX) || !isValidNetwork(requested)) {
    return err(`Unknown protocol network in the worker name "${name}"`);
  }
  return ok(requested);
}

/** The worker name that carries `network`. Never throws. */
export function toWorkerName(network: Network): string {
  return `${NETWORK_NAME_PREFIX}${network}`;
}
