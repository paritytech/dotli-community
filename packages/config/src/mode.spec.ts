// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { defaultBackend, isSharedWorkerAvailable } from './mode.js';

describe('isSharedWorkerAvailable', () => {
  it('As a host on a browser with SharedWorker, I detect the shared light client can run', () => {
    // Given
    const scope = {
      SharedWorker: class {
        readonly port: unknown = null;
      },
    };

    // When
    const available = isSharedWorkerAvailable(scope);

    // Then
    expect(available).toBe(true);
  });

  it('As a host on a browser without SharedWorker, I detect the shared light client cannot run', () => {
    // When
    const available = isSharedWorkerAvailable({});

    // Then
    expect(available).toBe(false);
  });
});

describe('defaultBackend', () => {
  it('As a new visitor, I start on the per-tab light client whether or not my browser has SharedWorker', () => {
    // When / Then
    expect(defaultBackend()).toBe('smoldot-direct');
  });
});
