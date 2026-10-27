// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { isSharedWorkerAvailable } from './isSharedWorkerAvailable.js';

describe('isSharedWorkerAvailable', () => {
  it('As a host on a browser with SharedWorker, I detect the shared light client can run', () => {
    // Given
    const scope = {
      SharedWorker: class {
        readonly port: unknown = null;
      },
    };

    // When
    const available = isSharedWorkerAvailable({ scope });

    // Then
    expect(available).toBe(true);
  });

  it('As a host on a browser without SharedWorker, I detect the shared light client cannot run', () => {
    // When
    const available = isSharedWorkerAvailable({ scope: {} });

    // Then
    expect(available).toBe(false);
  });
});
