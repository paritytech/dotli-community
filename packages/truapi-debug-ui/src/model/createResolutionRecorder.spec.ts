// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import { buildSystemEvent } from '../testing/buildSystemEvent.js';
import { BOOT_STARTED } from '../testing/constants.js';
import { createResolutionRecorder, type ResolutionRecorder } from './createResolutionRecorder.js';

/** A load phase the recorder keeps. */
const RESOLVE_STARTED: DotliDebugEvent = buildSystemEvent({
  layer: 'resolve',
  event: 'started',
  payload: { label: 'app', source: 'smoldot' },
});

/** A bridge step, which belongs to no load phase. */
const BRIDGE_SETUP: DotliDebugEvent = buildSystemEvent({
  layer: 'bridge',
  event: 'setup_begin',
  payload: { label: 'app', productId: 'app.dot' },
});

describe('createResolutionRecorder()', () => {
  it('As the Resolution view, I record past 4000 events and the newest 4000 are kept without reallocating', () => {
    // Given
    const recorder = createResolutionRecorder();
    for (let index = 0; index < 4000; index++) {
      recorder.record(buildSystemEvent({ ...BOOT_STARTED, flowId: `flow-${String(index)}` }));
    }
    const full = recorder.events();

    // When
    recorder.record(buildSystemEvent({ ...BOOT_STARTED, flowId: 'flow-4000' }));
    recorder.record(buildSystemEvent({ ...BOOT_STARTED, flowId: 'flow-4001' }));

    // Then
    expect(recorder.events()).toBe(full);
    expect(full).toHaveLength(4000);
    expect(full[0]?.flowId).toBe('flow-2');
    expect(full[3999]?.flowId).toBe('flow-4001');
  });

  it.each([
    {
      change: 'record a step of no load phase',
      apply: (recorder: ResolutionRecorder) => {
        recorder.record(BRIDGE_SETUP);
      },
      bump: 0,
    },
    {
      change: 'record a load phase',
      apply: (recorder: ResolutionRecorder) => {
        recorder.record(RESOLVE_STARTED);
      },
      bump: 1,
    },
    {
      change: 'clear the events',
      apply: (recorder: ResolutionRecorder) => {
        recorder.clear();
      },
      bump: 1,
    },
  ])('As the Resolution view, I $change and the version goes up by $bump', ({ apply, bump }) => {
    // Given
    const recorder = createResolutionRecorder();
    recorder.record(RESOLVE_STARTED);
    const before = recorder.version();

    // When
    apply(recorder);

    // Then
    expect(recorder.version()).toBe(before + bump);
  });
});
