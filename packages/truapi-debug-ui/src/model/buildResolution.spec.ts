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
