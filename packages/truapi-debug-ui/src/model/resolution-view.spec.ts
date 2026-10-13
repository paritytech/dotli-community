// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import { buildResolution, createResolutionRecorder } from './resolution-view.js';

function load(hits: number, misses: number): DotliDebugEvent[] {
  return [
    {
      layer: 'boot',
      event: 'started',
      flowId: 'boot-1',
      timestamp: 0,
      payload: {
        chainBackend: 'smoldot-direct',
        skipCidCache: false,
        skipArchiveCache: false,
      },
    },
    {
      layer: 'boot',
      event: 'block_cache',
      flowId: 'boot-1',
      timestamp: 50,
      payload: { hits, misses },
    },
  ];
}

describe('resolution summary: archive cache', () => {
  it("As a developer, a load served entirely from the host's block cache reads as an archive cache hit", () => {
    // When
    const model = buildResolution(load(12, 0), 100);

    // Then
    expect(model.summary.archiveCache).toBe('hit');
  });

  it('As a developer, a load that fetched any block over the network reads as a miss', () => {
    // When
    const model = buildResolution(load(3, 2), 100);

    // Then
    expect(model.summary.archiveCache).toBe('miss');
  });
});

function systemEvent(layer: string, event = 'started'): DotliDebugEvent {
  return {
    layer,
    event,
    flowId: 'f',
    timestamp: 0,
    payload: {},
  } as unknown as DotliDebugEvent;
}

describe('createResolutionRecorder()', () => {
  it('As the Resolution view, I keep the newest 4000 events without reallocating once full', () => {
    // Given
    const recorder = createResolutionRecorder();
    for (let i = 0; i < 4000; i++) {
      recorder.record(systemEvent('boot', `e${String(i)}`));
    }
    const full = recorder.events();

    // When
    recorder.record(systemEvent('boot', 'e4000'));
    recorder.record(systemEvent('boot', 'e4001'));

    // Then
    expect(recorder.events()).toBe(full);
    expect(full).toHaveLength(4000);
    expect(full[0]?.event).toBe('e2');
    expect(full[3999]?.event).toBe('e4001');
  });

  it('As the Resolution view, I see the version go up on a kept event and on a clear only', () => {
    // Given
    const recorder = createResolutionRecorder();
    const v0 = recorder.version();

    // When
    recorder.record(systemEvent('bridge'));

    // Then
    expect(recorder.version()).toBe(v0);

    // When
    recorder.record(systemEvent('resolve'));

    // Then
    expect(recorder.version()).toBe(v0 + 1);

    // When
    recorder.clear();

    // Then
    expect(recorder.version()).toBe(v0 + 2);
  });
});
