// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { str, type Codec } from 'scale-ts';
import { describe, expect, it } from 'vitest';
import type { ChainSyncKind, SmoldotDbChain, SmoldotDbOutcome } from '@dotli/chains';
import type { ChainRole } from '@dotli/config';
import type { ExecutableManifest, ManifestResult, ResolvePhase, RootManifest } from '@dotli/resolver';
import {
  chainRoleCodec,
  chainSyncEventCodec,
  chainSyncKindCodec,
  executableManifestCodec,
  manifestResultCodec,
  resolvePhaseCodec,
  rootManifestCodec,
  smoldotDbChainCodec,
  smoldotDbOutcomeCodec,
} from './codec-values.js';

function roundTrip<T>(codec: Codec<T>, value: T): T {
  return codec.dec(codec.enc(value));
}

describe('codec values', () => {
  it('As the frame, I send every chain role, sync kind, resolve phase and db outcome and the host reads the same value', () => {
    // Given
    const roles: ChainRole[] = ['relay', 'assethub', 'bulletin', 'people'];
    const dbChains: SmoldotDbChain[] = ['relay', 'assethub', 'bulletin'];
    const outcomes: SmoldotDbOutcome[] = ['hit', 'miss', 'unavailable'];
    const kinds: ChainSyncKind[] = [
      'firstPeer',
      'bootstrapComplete',
      'stalled',
      'recovered',
      'peers',
      'connecting',
      'warpSyncProgress',
      'warpSyncFinished',
    ];
    const phases: ResolvePhase[] = [
      'asset-hub-connecting',
      'asset-hub-syncing',
      'asset-hub-ready',
      'resolving-content',
    ];

    // When / Then
    expect(roles.map(value => roundTrip(chainRoleCodec, value))).toEqual(roles);
    expect(dbChains.map(value => roundTrip(smoldotDbChainCodec, value))).toEqual(dbChains);
    expect(outcomes.map(value => roundTrip(smoldotDbOutcomeCodec, value))).toEqual(outcomes);
    expect(kinds.map(value => roundTrip(chainSyncKindCodec, value))).toEqual(kinds);
    expect(phases.map(value => roundTrip(resolvePhaseCodec, value))).toEqual(phases);
  });

  it('As the frame, I send a root manifest with and without trusted products unchanged', () => {
    // Given
    const base = { $v: 1, displayName: 'App', description: 'An app', icon: { cid: 'bafy', format: 'png' } } as const;
    const withProducts: RootManifest = { ...base, trustedProducts: { 'a.dot': ['x', 'y'] } };
    const without: RootManifest = { ...base };

    // When
    const decodedWith = roundTrip(rootManifestCodec, withProducts);
    const decodedWithout = roundTrip(rootManifestCodec, without);

    // Then
    expect(decodedWith).toEqual(withProducts);
    expect(decodedWithout).toEqual(without);
  });

  it('As the frame, I send every executable kind unchanged', () => {
    // Given
    const app: ExecutableManifest = { $v: 1, kind: 'app', appVersion: [1, 2, 3] };
    const widget: ExecutableManifest = {
      $v: 1,
      kind: 'widget',
      appVersion: [1, 2, 3, 'beta'],
      dimensions: { height: [100, 4_294_967_296] },
    };
    const worker: ExecutableManifest = {
      $v: 1,
      kind: 'worker',
      appVersion: [1, 0, 0],
      entrypoint: 'worker.js',
      includes: { chat: true },
    };
    const wideWidget: ExecutableManifest = { ...widget, dimensions: { height: [1], width: 300 } };

    // When
    const decoded = [app, widget, worker, wideWidget].map(value => roundTrip(executableManifestCodec, value));

    // Then
    expect(decoded).toEqual([app, widget, worker, wideWidget]);
  });

  it('As the frame, I send every manifest result kind unchanged', () => {
    // Given
    const codec = manifestResultCodec(str);
    const results: ManifestResult<string>[] = [
      { kind: 'ok', value: 'v', raw: '{"a":1}' },
      { kind: 'empty' },
      { kind: 'unsupported', reason: 'no slot' },
      { kind: 'invalid', errors: ['one', 'two'], raw: '{}' },
      { kind: 'unsupported-version', version: '2', raw: '{"$v":2}' },
      { kind: 'unsupported-version', version: 'undefined', raw: '{}' },
    ];

    // When
    const decoded = results.map(value => roundTrip(codec, value));

    // Then
    expect(decoded).toStrictEqual(results);
  });

  it('As the frame, I send a sync event with only the fields it has', () => {
    // Given
    const event = { chain: 'assethub', kind: 'peers', peers: 4, isSyncing: false } as const;

    // When
    const decoded = roundTrip(chainSyncEventCodec, event);

    // Then
    expect(decoded).toEqual(event);
  });
});
