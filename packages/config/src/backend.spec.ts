// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { Backend } from './backend.js';
import {
  BACKEND_FACTS,
  getDefaultBackend,
  hasLightClient,
  hasSharedWorker,
  isVerifiedSession,
  parseBackend,
} from './backend.js';

describe('getDefaultBackend', () => {
  it('As a new visitor, I start on the per-tab light client', () => {
    // When
    const backend = getDefaultBackend();

    // Then
    expect(backend).toBe('smoldot-direct');
  });
});

describe('parseBackend', () => {
  it.each(['smoldot-direct', 'smoldot-shared-worker', 'rpc-gateway'])(
    'As a visitor, I bring the backend %s and it is read as written',
    raw => {
      // When
      const backend = parseBackend(raw);

      // Then
      expect(backend).toBe(raw);
    },
  );

  it.each([null, '', 'rpc', 'toString', 'a-backend-from-a-newer-deploy'])(
    'As a visitor, I bring the backend %j and it names none',
    raw => {
      // When
      const backend = parseBackend(raw);

      // Then
      expect(backend).toBeNull();
    },
  );
});

describe('backend facts', () => {
  it.each<{ backend: Backend; lightClient: boolean; sharedWorker: boolean; failover: Backend }>([
    { backend: 'smoldot-direct', lightClient: true, sharedWorker: false, failover: 'rpc-gateway' },
    { backend: 'smoldot-shared-worker', lightClient: true, sharedWorker: true, failover: 'rpc-gateway' },
    { backend: 'rpc-gateway', lightClient: false, sharedWorker: false, failover: 'smoldot-shared-worker' },
  ])(
    'As the page on $backend, I ask its capabilities and it answers light client $lightClient, shared worker $sharedWorker, failover $failover',
    ({ backend, lightClient, sharedWorker, failover }) => {
      // Given the row's backend, from the table

      // When
      const answers = {
        lightClient: hasLightClient(backend),
        sharedWorker: hasSharedWorker(backend),
        verified: isVerifiedSession(backend),
        failover: BACKEND_FACTS[backend].failover,
      };

      // Then
      expect(answers).toEqual({ lightClient, sharedWorker, verified: lightClient, failover });
    },
  );
});
