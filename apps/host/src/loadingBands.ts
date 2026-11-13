// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The loading bar's bands on each backend, and where the resolver's and the chains' milestones and the content's
// counted bytes move the bar. Bands follow where load time goes: Asset Hub sync and the content fetch own most of the
// bar.

import type { ChainSyncEvent } from '@dotli/chains';
import type { Backend } from '@dotli/config';
import type { ResolvePhase } from '@dotli/resolver';
import type { LoadingController, LoadingPhase } from './createLoadingController.js';

type Bar = Pick<LoadingController, 'advancePhase' | 'nudgePhaseProgress' | 'releasePhaseProgress' | 'setLoadingStage'>;

// Connecting takes no time, so it shares the Syncing band.
const BAND_BY_RESOLVE_PHASE: Partial<Record<ResolvePhase, number>> = {
  'asset-hub-connecting': 1,
  'asset-hub-syncing': 1,
  'asset-hub-ready': 1,
  'resolving-content': 2,
};

const GATEWAY_BANDS: LoadingPhase[] = [
  { label: 'Connecting', base: 5, target: 50, expectedMs: 1200, stage: 'relay' },
  { label: 'Resolving', base: 50, target: 62, expectedMs: 1200, stage: 'resolving' },
  // No `reportsProgress`: the sandbox pulls the archive over HTTP, so nothing counts its bytes here.
  { label: 'Fetching content', base: 62, target: 95, expectedMs: 10000, stage: 'content' },
];

/** The bar's bands on `backend`. The download is always the last. */
export function getLoadingBands(backend: Backend): LoadingPhase[] {
  switch (backend) {
    case 'rpc-gateway':
      return GATEWAY_BANDS;
    case 'smoldot-shared-worker':
      return getSmoldotBands('Starting Worker', false);
    case 'smoldot-direct':
      // Only direct mode relays bitswap through this window, so only it can report a download percentage.
      return getSmoldotBands('Starting', true);
  }
}

/** Moves the light client's bar to a resolver milestone's band. One the bar has no band for leaves it. Never throws. */
export function moveBarOnResolvePhase(phase: ResolvePhase, bar: Bar): void {
  const band = BAND_BY_RESOLVE_PHASE[phase];
  if (band !== undefined) {
    bar.advancePhase(band);
  }
}

/** Moves the light client's bar on the content fetch's counted bytes. Never throws. */
export function moveBarOnContentProgress(bytesFetched: number, totalBytes: number | null, bar: Bar): void {
  if (totalBytes === null) {
    // No declared total, so no percentage: the clock takes the bar back.
    bar.releasePhaseProgress();
    return;
  }
  if (totalBytes > 0) {
    bar.nudgePhaseProgress(bytesFetched / totalBytes, 'content');
    // The tail is the sandbox unpacking and painting. Only relayed blocks count, so this cannot fire early.
    if (bytesFetched >= totalBytes) {
      bar.setLoadingStage('preparing');
    }
  }
}

/** Moves the light client's bar on a chain's lifecycle milestone. Never throws. */
export function moveBarOnChainSync(event: ChainSyncEvent, bar: Bar): void {
  switch (event.kind) {
    case 'peers':
      // With a peer the download can start, so the clock takes over: a cached archive never asks for a block.
      if (event.chain === 'bulletin' && event.peers !== undefined && event.peers > 0) {
        bar.releasePhaseProgress();
      }
      return;
    case 'warpSyncProgress': {
      // The one true percentage smoldot offers. Adding the relay happens inside the starting band, so its warp
      // fills that band.
      const { at, target } = event;
      if (event.chain === 'relay' && at !== undefined && target !== undefined && target > 0 && at <= target) {
        bar.nudgePhaseProgress(at / target, 'starting');
      }
      return;
    }
    case 'firstPeer':
      if (event.chain === 'assethub') {
        bar.advancePhase(1);
      }
      return;
    case 'bootstrapComplete':
      if (event.chain === 'assethub') {
        bar.advancePhase(2);
      }
      return;
    case 'warpSyncFinished':
      // The last sample lands short of the target, which would leave the band just below full.
      if (event.chain === 'relay') {
        bar.nudgePhaseProgress(1, 'starting');
      }
      return;
    case 'connecting':
    case 'stalled':
    case 'recovered':
      // The per-chain peer counts already show these.
      return;
  }
}

/** The visitor reads the stage's copy, not the label. */
function getSmoldotBands(startLabel: string, countsContentBytes: boolean): LoadingPhase[] {
  return [
    { label: startLabel, base: 2, target: 10, expectedMs: 770, stage: 'starting' },
    { label: 'Syncing Asset Hub', base: 10, target: 55, expectedMs: 6500, stage: 'assetHub' },
    { label: 'Resolving', base: 55, target: 62, expectedMs: 1200, stage: 'resolving' },
    {
      label: 'Fetching content',
      base: 62,
      target: 95,
      expectedMs: 10000,
      stage: 'content',
      // Driven by counted bytes, only where something counts them, or the bar would hold at 62 for the whole fetch.
      reportsProgress: countsContentBytes,
    },
  ];
}
