// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Backend } from '@dotli/config';
import type { StatusTone } from '@dotli/ui';
import type { LiveVerdict } from '../../network-verdict.js';
import type { ChainView } from './chains.js';

/** Whether a chain in use waits for its first bar with its last block known, so its countdown has to tick. */
export function needsCountdown(
  chains: readonly Pick<ChainView, 'reachable' | 'state' | 'bars' | 'sinceLast'>[],
): boolean {
  return chains.some(
    chain => chain.reachable && chain.state !== 'unused' && chain.bars.length === 0 && chain.sinceLast !== null,
  );
}

export interface NetworkStatusLine {
  tone: StatusTone;
  title: string;
  detail: string | null;
}

const UNSETTLED_TITLES: Record<'idle' | 'warn', string> = {
  idle: 'Syncing',
  warn: 'Connection is unstable',
};

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

/** The gateway has no peers and verifies nothing, so its captions say neither. */
interface Captions {
  offline: string;
  ok: (chainCount: number) => string;
  slow: (names: readonly string[]) => string;
  starting: string;
}

const LIGHT_CLIENT: Captions = {
  offline: 'No peers on any chain. Retrying.',
  ok: chainCount => `Light client is ${inSync(chainCount)}`,
  slow: names => `${joinNames(names)} ${names.length === 1 ? 'is' : 'are'} behind`,
  starting: 'Finding peers. This takes a few seconds.',
};

const GATEWAY: Captions = {
  offline: 'Trusted providers are out of reach. Retrying.',
  ok: () => 'Served by trusted providers',
  slow: names => `${joinNames(names)} ${names.length === 1 ? 'is' : 'are'} behind`,
  starting: 'Reaching trusted providers. This takes a few seconds.',
};

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
  const captions = backend === 'rpc-gateway' ? GATEWAY : LIGHT_CLIENT;
  if (offline) {
    return { tone: 'err', title: 'You are offline', detail: captions.offline };
  }
  if (verdict.tone === 'quiet') {
    return { tone: 'quiet', title: 'No chains in use', detail: 'Chains appear here once the app connects to them.' };
  }
  const { text, tone, slow } = verdict;
  if (tone === 'ok') {
    return { tone, title: text, detail: captions.ok(chainCount) };
  }
  if (tone === 'warn') {
    return { tone, title: UNSETTLED_TITLES[tone], detail: captions.slow(slow ?? []) };
  }
  return { tone, title: UNSETTLED_TITLES[tone], detail: captions.starting };
}
