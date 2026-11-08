// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { hasLightClient, type Backend } from '@dotli/config';
import { NETWORK_HEALTH } from '../../networkVerdict.js';
import type { LiveVerdict, NetworkHealth } from '../../networkVerdict.js';
import type { ChainView } from './chains.js';

/** Whether a chain in use waits for its first bar with its last block known, so its countdown has to tick. */
export function needsCountdown(
  chains: readonly Pick<ChainView, 'reachable' | 'state' | 'bars' | 'sinceLast'>[],
): boolean {
  return chains.some(
    chain => chain.reachable && chain.state !== 'unused' && chain.bars.length === 0 && chain.sinceLast !== null,
  );
}

export type NetworkStatusLine = {
  tone: NetworkHealth;
  title: string;
  detail: string;
};

/** What a caption reads of the network. */
type CaptionFacts = { chainCount: number; slow: readonly string[] };

/** A backend's caption for each health. */
type Captions = Record<NetworkHealth, (facts: CaptionFacts) => string>;

const QUIET_DETAIL = 'Chains appear here once the app connects to them.';

const NUMBER_WORDS = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** "A", "A and B", "A, B and C". */
function joinNames(names: readonly string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

/** "in sync", "in sync on both chains", "in sync on all four chains". */
function inSync(chainCount: number): string {
  if (chainCount < 2) {
    return 'in sync';
  }
  if (chainCount === 2) {
    return 'in sync on both chains';
  }
  return `in sync on all ${NUMBER_WORDS[chainCount - 2] ?? String(chainCount)} chains`;
}

const LIGHT_CLIENT = {
  ok: ({ chainCount }) => `Light client is ${inSync(chainCount)}`,
  idle: () => 'Finding peers. This takes a few seconds.',
  warn: ({ slow }) => `${joinNames(slow)} ${slow.length === 1 ? 'is' : 'are'} behind`,
  err: () => 'No peers on any chain. Retrying.',
  quiet: () => QUIET_DETAIL,
} satisfies Captions;

/** The gateway has no peers and verifies nothing, so its captions say neither. */
const GATEWAY = {
  ok: () => 'Served by trusted providers',
  idle: () => 'Reaching trusted providers. This takes a few seconds.',
  warn: ({ slow }) => `${joinNames(slow)} ${slow.length === 1 ? 'is' : 'are'} behind`,
  err: () => 'Trusted providers are out of reach. Retrying.',
  quiet: () => QUIET_DETAIL,
} satisfies Captions;

/**
 * The network menu's status line.
 * Offline wins, as for the capsule and the network badge, so the three never disagree.
 */
export function describeNetworkStatus(
  verdict: LiveVerdict,
  offline: boolean,
  chainCount = 0,
  backend?: Backend,
): NetworkStatusLine {
  const captions: Captions = backend === undefined || hasLightClient(backend) ? LIGHT_CLIENT : GATEWAY;
  const tone: NetworkHealth = offline ? 'err' : verdict.tone;
  return {
    tone,
    title: NETWORK_HEALTH[tone].title,
    detail: captions[tone]({ chainCount, slow: verdict.slow ?? [] }),
  };
}
