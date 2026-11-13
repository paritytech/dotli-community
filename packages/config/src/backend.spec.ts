// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { parseBackend } from './backend.js';

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
