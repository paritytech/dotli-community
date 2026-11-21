// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The loading bar's bands on each backend, and where the resolver's and the chains' milestones and the content's
// counted bytes move the bar. Bands follow where load time goes: Asset Hub sync and the content fetch own most of the
// bar.

import type { ChainSyncEvent } from '@dotli/chains';
import type { Backend } from '@dotli/config';
import type { ResolvePhase } from '@dotli/resolver';
import type { LoadingController, LoadingPhase, LoadingStage } from './createLoadingController.js';
import { getWarpShare } from './getWarpShare.js';

type Bar = Pick<LoadingController, 'advancePhase' | 'nudgePhaseProgress' | 'releasePhaseProgress' | 'setLoadingStage'>;

/** A backend's bands, never empty, as the bar opens on the first. */
type Bands = [LoadingPhase, ...LoadingPhase[]];

// Connecting takes no time, so it shares the Syncing band.
const STAGE_BY_RESOLVE_PHASE: Partial<Record<ResolvePhase, LoadingStage>> = {
  'asset-hub-connecting': 'assetHub',
  'asset-hub-syncing': 'assetHub',
  'asset-hub-ready': 'assetHub',
  'resolving-content': 'resolving',
};

const ASSET_HUB_BAND: LoadingPhase = {
  label: 'Syncing Asset Hub',
  base: 10,
  target: 55,
  expectedMs: 6500,
  stage: 'assetHub',
};

const LIGHT_CLIENT_RESOLVING_BAND: LoadingPhase = {
  label: 'Resolving',
  base: 55,
  target: 62,
  expectedMs: 1200,
  stage: 'resolving',
};

const CONTENT_BAND: LoadingPhase = {
  label: 'Fetching content',
  base: 62,
  target: 95,
  expectedMs: 10000,
  stage: 'content',
};

/** The bar's bands on each backend. The visitor reads each stage's copy, not the label. */
const BANDS_BY_BACKEND = {
  'rpc-gateway': [
    { label: 'Connecting', base: 5, target: 50, expectedMs: 1200, stage: 'relay' },
    { label: 'Resolving', base: 50, target: 62, expectedMs: 1200, stage: 'resolving' },
    // The sandbox pulls the archive over HTTP, so nothing counts its bytes here.
    CONTENT_BAND,
  ],
  'smoldot-shared-worker': [
    { label: 'Starting Worker', base: 2, target: 10, expectedMs: 770, stage: 'starting' },
    ASSET_HUB_BAND,
    LIGHT_CLIENT_RESOLVING_BAND,
    CONTENT_BAND,
  ],
  'smoldot-direct': [
    { label: 'Starting', base: 2, target: 10, expectedMs: 770, stage: 'starting' },
    ASSET_HUB_BAND,
    LIGHT_CLIENT_RESOLVING_BAND,
    // Only direct mode relays bitswap through this window, so only its download counts bytes to drive the band. A
    // band driven by bytes that nothing counts would hold at its base for the whole fetch.
    { ...CONTENT_BAND, reportsProgress: true },
  ],
} satisfies Record<Backend, Bands>;

/** The bar's bands on `backend`. */
export function getLoadingBands(backend: Backend): Bands {
  return BANDS_BY_BACKEND[backend];
}

/** Moves the bar to the download's band. */
export function moveBarToDownload(bar: Bar): void {
  bar.advancePhase('content');
}

/** Moves the light client's bar to a resolver milestone's band. One the bar has no band for leaves it. */
export function moveBarOnResolvePhase(phase: ResolvePhase, bar: Bar): void {
  const stage = STAGE_BY_RESOLVE_PHASE[phase];
  if (stage !== undefined) {
    bar.advancePhase(stage);
  }
}

/** Moves the light client's bar on the content fetch's counted bytes. */
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

/** Moves the light client's bar on a chain's lifecycle milestone. */
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
      const share = getWarpShare(event);
      if (event.chain === 'relay' && share !== null) {
        bar.nudgePhaseProgress(share, 'starting');
      }
      return;
    }
    case 'firstPeer':
      if (event.chain === 'assethub') {
        bar.advancePhase('assetHub');
      }
      return;
    case 'bootstrapComplete':
      if (event.chain === 'assethub') {
        bar.advancePhase('resolving');
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
