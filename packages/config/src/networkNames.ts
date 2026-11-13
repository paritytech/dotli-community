// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The networks this build knows, by the name the settings and the URL carry. */
export type Network = 'paseo-next-v2' | 'previewnet';

export const NETWORK_NAMES: readonly Network[] = ['paseo-next-v2', 'previewnet'];

/** The settings key under which the chosen network's name is stored. */
export const NETWORK_KEY = 'dotli:network';

/** The set of network names this build knows, for a membership check on an untyped string. */
const VALID_NETWORKS: ReadonlySet<string> = new Set<string>(NETWORK_NAMES);

/** Whether `value` names a network this build knows. */
export function isValidNetwork(value: string): value is Network {
  return VALID_NETWORKS.has(value);
}
