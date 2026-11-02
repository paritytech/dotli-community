// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getBackendOfFrameMode } from './getBackendOfFrameMode.js';

describe('getBackendOfFrameMode', () => {
  it('As the protocol frame, I read each backend from the word a host page of any release puts in my URL, and no other word', () => {
    // When
    const read = ['shared-worker', 'direct', 'rpc', 'smoldot-direct', ''].map(getBackendOfFrameMode);

    // Then
    expect(read).toEqual(['smoldot-shared-worker', 'smoldot-direct', 'rpc-gateway', null, null]);
  });
});
