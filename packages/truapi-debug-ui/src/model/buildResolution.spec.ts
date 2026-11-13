// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import { buildSystemEvent } from '../testing/buildSystemEvent.js';
import { BOOT_STARTED } from '../testing/constants.js';
import { buildResolution } from './buildResolution.js';

/** A boot that took `hits` blocks from the host's block cache and `misses` from the network. */
function buildLoad(hits: number, misses: number): DotliDebugEvent[] {
  return [
    buildSystemEvent({ ...BOOT_STARTED, flowId: 'boot-1' }),
    buildSystemEvent({
      layer: 'boot',
      event: 'block_cache',
      flowId: 'boot-1',
      timestamp: 50,
      payload: { hits, misses },
    }),
  ];
}

describe('resolution summary: archive cache', () => {
  it("As a developer, I load entirely from the host's block cache and the archive cache reads as a hit", () => {
    // When
    const model = buildResolution(buildLoad(12, 0), 100);

    // Then
    expect(model.summary.archiveCache).toBe('hit');
  });

  it('As a developer, I load a block over the network and the archive cache reads as a miss', () => {
    // When
    const model = buildResolution(buildLoad(3, 2), 100);

    // Then
    expect(model.summary.archiveCache).toBe('miss');
  });
});

describe('resolution summary: backend', () => {
  it.each<{ from: string; to: string; expected: 'smoldot' | 'rpc-gateway' }>([
    { from: 'rpc-gateway', to: 'smoldot-shared-worker', expected: 'smoldot' },
    { from: 'rpc-gateway', to: 'smoldot-direct', expected: 'smoldot' },
    { from: 'smoldot', to: 'rpc-gateway', expected: 'rpc-gateway' },
    { from: 'rpc-gateway', to: 'a-backend-from-a-newer-deploy', expected: 'rpc-gateway' },
  ])(
    "As a developer, I watch a load fail over from $from to $to and the summary's transport reads $expected",
    ({ from, to, expected }) => {
      // Given a load that boots on `from` and fails over to `to`
      const events = [
        buildSystemEvent({
          layer: 'boot',
          event: 'started',
          flowId: 'boot-1',
          payload: { chainBackend: from, skipCidCache: false, skipArchiveCache: false },
        }),
        buildSystemEvent({
          layer: 'failover',
          event: 'chain_backend',
          flowId: 'boot-1',
          timestamp: 10,
          payload: { from, to, reason: 'resolution failed' },
        }),
      ];

      // When the resolution is built
      const model = buildResolution(events, 100);

      // Then the summary's transport follows the failover target
      expect(model.summary.backend).toBe(expected);
    },
  );
});

describe('resolution rows: peers', () => {
  it.each<{ story: string; atReady: number; later: number; expected: number }>([
    { story: 'gains peers a moment after it goes ready', atReady: 0, later: 5, expected: 5 },
    { story: 'loses peers after it goes ready', atReady: 4, later: 1, expected: 4 },
  ])(
    'As a developer, I watch a chain that $story and its row counts the most peers it had',
    ({ atReady, later, expected }) => {
      // Given a load whose relay chain goes ready with some peers and then reports another count
      const events = [
        buildSystemEvent({ ...BOOT_STARTED, flowId: 'boot-1' }),
        buildSystemEvent({
          layer: 'chain',
          event: 'phase',
          flowId: 'chain-1',
          timestamp: 10,
          payload: { chain: 'relay', phase: 'ready', peers: atReady },
        }),
        buildSystemEvent({
          layer: 'chain',
          event: 'peers',
          flowId: 'chain-1',
          timestamp: 20,
          payload: { chain: 'relay', peers: later },
        }),
        buildSystemEvent({
          layer: 'boot',
          event: 'ready',
          flowId: 'boot-1',
          timestamp: 30,
          payload: { label: 'app', totalMs: 30, path: 'slow' },
        }),
      ];

      // When the resolution is built
      const model = buildResolution(events, 100);

      // Then the relay row counts the most peers it had
      expect(model.rows.find(row => row.role === 'relay')?.peers).toBe(expected);
    },
  );
});
