// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The network a story gives the network button and panel, which a play moves.

import { createSignal, onCleanup } from 'solid-js';
import { expect, userEvent, waitFor } from 'storybook/test';
import type { Backend } from '@dotli/config';
import type { BlockHealth } from '../../features/network/networkMonitorState.js';
import type { ChainBar } from '../../features/network/chain.js';
import type { ChainView, NetworkView, TransferView } from '../../features/network/chains.js';
import { describeLiveNetwork } from '../../features/network/networkVerdict.js';
import type { LiveVerdict, NetworkHealth } from '../../features/network/networkVerdict.js';
import type { NetworkItemProps } from '../../features/network/NetworkItem.js';

const NO_TRANSFER: TransferView = { bytesPerSecond: null, fetched: null, total: null };

/** Verdicts a story gives the network in place of the one its chains earn. */
export const VERDICTS = {
  quiet: { tone: 'quiet' },
  unreachable: { tone: 'unreachable' },
  connecting: { tone: 'idle' },
  good: { tone: 'ok' },
} satisfies Record<string, LiveVerdict>;

/** The verdict while the `labels` chains are behind. */
export function waitingOn(...labels: string[]): LiveVerdict {
  return { tone: 'warn', slow: labels };
}

const NOTHING: NetworkView = { chains: [], transfer: NO_TRANSFER, readAt: 0, verdict: VERDICTS.quiet };

const [network, setNetwork] = createSignal<NetworkView>(NOTHING);
const [health, setHealthSignal] = createSignal<NetworkHealth>('quiet');
const [productLoaded, setProductLoadedSignal] = createSignal(false);
function backend(): Backend | undefined {
  return undefined;
}

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
 * The network, read just now, so the rows age from it, with the health its verdict earns online. With no
 * `verdict`, it is the one the chains earn with no alarm raised, so the status line agrees with the rows.
 */
export function given(
  chains: ChainView[],
  transfer: TransferView = NO_TRANSFER,
  verdict: LiveVerdict = describeLiveNetwork(chains.map(chain => ({ ...chain, alarm: false }))),
): void {
  setNetwork({ chains, transfer, readAt: Date.now(), verdict });
  setHealthSignal(verdict.tone);
}

const CLOSED_ROW = '#chains-popover [data-testid="chains-row-head"][aria-expanded="false"]';

/** Opens every closed chain row in the popover, so each shows its block strip. */
export async function openChainRows(): Promise<void> {
  for (const head of document.querySelectorAll<HTMLElement>(CLOSED_ROW)) {
    await userEvent.click(head);
  }
  await waitFor(() => expect(document.querySelector(CLOSED_ROW)).toBeNull());
}

export function setHealth(next: NetworkHealth): void {
  setHealthSignal(next);
}

export function setProductLoaded(loaded: boolean): void {
  setProductLoadedSignal(loaded);
}

/** For a story's `beforeEach`: no chain in use, quiet, the product loading, the settings not read yet. */
export function resetStoryNetwork(): void {
  setNetwork(NOTHING);
  setHealthSignal('quiet');
  setProductLoadedSignal(false);
  follows.started = 0;
  follows.following = 0;
}
