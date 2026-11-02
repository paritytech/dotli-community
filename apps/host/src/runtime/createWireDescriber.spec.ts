// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { bindReports } from '../testing/bindReports.js';
import { createWireDescriber } from './createWireDescriber.js';
import * as WireDescribe from './debugWireDescribe.js';

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

  it('As a dotli developer in debug mode, I send a frame after the describer failed to load and it loads again', async () => {
    // Given a describer whose first load fails
    bindReports();
    const load = vi.fn<() => Promise<typeof WireDescribe>>();
    load.mockRejectedValueOnce(new Error('chunk missing'));
    load.mockResolvedValue(WireDescribe);
    const describer = createWireDescriber({ load });
    await describer.preload().catch(() => undefined);

    // When the next frame asks
    const loaded = await describer.preload();

    // Then the chunk loaded on the second try
    expect(loaded).toBe(WireDescribe);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('As a dotli developer in debug mode, I send three frames at once and the describer loads once for all of them', async () => {
    // Given a describer whose chunk loads
    const load = vi.fn(() => Promise.resolve(WireDescribe));
    const describer = createWireDescriber({ load });

    // When three frames wait on it
    const loaded = await Promise.all([describer.preload(), describer.preload(), describer.preload()]);

    // Then the chunk is fetched once and every frame gets the same module
    expect(load).toHaveBeenCalledOnce();
    expect(loaded.map(module => module === WireDescribe)).toEqual([true, true, true]);
  });
});
