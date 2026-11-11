// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { bindReports } from '../testing/bindReports.js';
import { createWireDescriber } from './createWireDescriber.js';
import type * as WireDescribe from './debugWireDescribe.js';

describe('wire describer', () => {
  it('As a dotli developer in debug mode, I send frames while the describer cannot load and its miss is counted once', async () => {
    // Given a describer whose chunk is gone
    const { captures } = bindReports();
    const load = vi.fn(() => Promise.reject<typeof WireDescribe>(new Error('chunk missing')));
    const describer = createWireDescriber({ load });

    // When three frames try it
    for (let frame = 0; frame < 3; frame += 1) {
      await describer.preload().catch(() => undefined);
    }

    // Then each frame tried the chunk, and the miss is counted once
    expect(load).toHaveBeenCalledTimes(3);
    expect(captures.expected).toHaveBeenCalledOnce();
    expect(captures.expected).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ step: 'wire_describe_load' }),
    );
  });
});
