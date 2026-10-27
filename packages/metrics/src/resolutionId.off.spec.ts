// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Runs in its own project with VITE_METRICS off, as a build without metrics compiles the module.

import { describe, expect, it } from 'vitest';
import { getResolutionId, setResolutionId } from './resolutionId.js';

describe('resolution id in a build without metrics', () => {
  it('As the sandbox on a build without metrics, I read back the resolution id the host passed, so the frames line up', () => {
    // When
    setResolutionId('resolution-1');
    const id = getResolutionId();

    // Then
    expect(id).toBe('resolution-1');
  });
});
