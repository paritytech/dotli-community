// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { hasLightClient, type Backend } from '@dotli/config';
import { NETWORK_HEALTH } from '../../networkVerdict.js';
import type { LiveVerdict, NetworkHealth } from '../../networkVerdict.js';
import { formatRate, formatSize } from '@dotli/shared';
import type { ChainView, TransferView } from './chains.js';

/** Whether a chain in use waits for its first bar with its last block known, so its countdown has to tick. */
export function needsCountdown(
  chains: readonly Pick<ChainView, 'reachable' | 'state' | 'bars' | 'sinceLast'>[],
): boolean {
  return chains.some(
    chain => chain.reachable && chain.state !== 'unused' && chain.bars.length === 0 && chain.sinceLast !== null,
  );
}

/** A row of the transfer footer. */
export type TransferRow = { label: string; value: string };

/**
 * The transfer footer while the product loads: its speed, and its size or how much of it came. Once the product is on
 * screen speed and size describe history, so both are null. A size shows only with a known, positive total.
 */
export function describeTransfer(
  transfer: TransferView,
  loading: boolean,
): { speed: TransferRow | null; size: TransferRow | null } {
  if (!loading) {
    return { speed: null, size: null };
  }
  const { bytesPerSecond, fetched, total } = transfer;
  const speed = bytesPerSecond === null ? null : { label: 'Speed', value: formatRate(bytesPerSecond) };
  if (fetched === null || total === null || total <= 0) {
    return { speed, size: null };
  }
  const size =
    fetched >= total
      ? { label: 'Size', value: formatSize(total) }
      : { label: 'Downloading', value: `${formatSize(fetched)} / ${formatSize(total)}` };
  return { speed, size };
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

/** The chains that lag, which either backend names the same way. */
function behindCaption({ slow }: CaptionFacts): string {
  return `${joinNames(slow)} ${slow.length === 1 ? 'is' : 'are'} behind`;
}

const LIGHT_CLIENT = {
  ok: ({ chainCount }) => `Light client is ${inSync(chainCount)}`,
  idle: () => 'Finding peers. This takes a few seconds.',
  warn: behindCaption,
  err: () => 'No peers on any chain. Retrying.',
  quiet: () => QUIET_DETAIL,
} satisfies Captions;

/** The gateway has no peers and verifies nothing, so its captions say neither. */
const GATEWAY = {
  ok: () => 'Served by trusted providers',
  idle: () => 'Reaching trusted providers. This takes a few seconds.',
  warn: behindCaption,
  err: () => 'Trusted providers are out of reach. Retrying.',
  quiet: () => QUIET_DETAIL,
} satisfies Captions;

/** Whether the menu speaks of a light client: under one, or while the page has not read its settings (`undefined`). */
export function isLightClientOrUnread(backend: Backend | undefined): boolean {
  return backend === undefined || hasLightClient(backend);
}

/**
 * The network menu's status line.
 * Offline wins, as for the capsule and the network badge, so the three never disagree.
 */
export function describeNetworkStatus({
  verdict,
  offline,
  chainCount,
  backend,
}: {
  verdict: LiveVerdict;
  offline: boolean;
  chainCount: number;
  backend: Backend | undefined;
}): NetworkStatusLine {
  const captions: Captions = isLightClientOrUnread(backend) ? LIGHT_CLIENT : GATEWAY;
  const tone: NetworkHealth = offline ? 'err' : verdict.tone;
  return {
    tone,
    title: NETWORK_HEALTH[tone].title,
    detail: captions[tone]({ chainCount, slow: verdict.slow ?? [] }),
  };
}
