// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The network a story gives the network button and panel. Plays move it the way the page's monitor and health do.

import { createSignal, onCleanup } from 'solid-js';
import type { Backend } from '@dotli/config';
import type { NetworkHealth } from '../../components/chains/network-health.js';
import type { BlockHealth } from '../../state/network-monitor.js';
import type { ChainBar } from '../../components/chains/chain.js';
import type { ChainView, NetworkView, TransferView } from '../../components/chains/chains.js';
import type { LiveVerdict } from '../../network-verdict.js';
import type { NetworkItemProps } from '../../components/chains/NetworkItem.js';

const NO_TRANSFER: TransferView = { bytesPerSecond: null, fetched: null, total: null };

/** Verdicts as the page words them. A story that checks the status line gives the one its chains earn. */
export const VERDICTS = {
  quiet: { text: 'Not in use', tone: 'quiet' },
  connecting: { text: 'Connecting', tone: 'idle' },
  good: { text: 'Your connection is good', tone: 'ok' },
} satisfies Record<string, LiveVerdict>;

/** The verdict while the `labels` chains are behind. */
export function waitingOn(...labels: string[]): LiveVerdict {
  return { text: `Waiting on ${labels.join(' and ')}`, tone: 'warn', slow: labels };
}

const NOTHING: NetworkView = { chains: [], transfer: NO_TRANSFER, readAt: 0, verdict: VERDICTS.quiet };

const [network, setNetwork] = createSignal<NetworkView>(NOTHING);
const [health, setHealthSignal] = createSignal<NetworkHealth>('quiet');
const [productLoaded, setProductLoadedSignal] = createSignal(false);
const [backend, setBackendSignal] = createSignal<Backend | undefined>(undefined);

/** How many times the panel started following the network, and how many of those still follow it. */
export const follows = { started: 0, following: 0 };

/** The props a page gives the network button. */
export const storyNetwork: NetworkItemProps = {
  health,
  productLoaded,
  backend,
  followNetwork: () => {
    follows.started += 1;
    follows.following += 1;
    onCleanup(() => {
      follows.following -= 1;
    });
    return network;
  },
};

/** A known chain in use, pending until it has a latest block, which only decides its state. */
export function chain(overrides: Partial<ChainView> & { latest?: number | null } = {}): ChainView {
  const latest = overrides.latest ?? null;
  return {
    key: overrides.role ?? 'relay',
    role: 'relay',
    label: 'Relay chain',
    bars: [],
    sinceLast: null,
    blockTimeMs: 6000,
    reachable: true,
    phase: null,
    peers: null,
    state: latest === null ? 'pending' : 'live',
    ...overrides,
  };
}

/** `count` bars from block `from`, each `gapMs` after the one before, all with `health`, as the story says. */
export function bars(from: number, count: number, gapMs = 6000, health: BlockHealth = 'onTime'): ChainBar[] {
  return Array.from({ length: count }, (_, i) => ({ number: from + i, health, gapMs }));
}

/**
 * The network, read just now, so a countdown shows its first value. With no `verdict`, chains in use are still
 * connecting.
 */
export function given(
  chains: ChainView[],
  transfer: TransferView = NO_TRANSFER,
  verdict: LiveVerdict = chains.length === 0 ? VERDICTS.quiet : VERDICTS.connecting,
): void {
  setNetwork({ chains, transfer, readAt: Date.now(), verdict });
}

export function setHealth(next: NetworkHealth): void {
  setHealthSignal(next);
}

export function setProductLoaded(loaded: boolean): void {
  setProductLoadedSignal(loaded);
}

export function setBackend(next: Backend | undefined): void {
  setBackendSignal(next);
}

/** For a story's `beforeEach`: no chain in use, quiet, the product loading, the settings not read yet. */
export function resetStoryNetwork(): void {
  setNetwork(NOTHING);
  setHealthSignal('quiet');
  setProductLoadedSignal(false);
  setBackendSignal(undefined);
  follows.started = 0;
  follows.following = 0;
}
