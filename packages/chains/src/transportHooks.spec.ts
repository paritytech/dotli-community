// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { isChainUp, type ConnectionStatus } from './transportHooks.js';

const CASES: { status: ConnectionStatus; up: boolean }[] = [
  { status: 'connecting', up: true },
  { status: 'connected', up: true },
  { status: 'disconnected', up: false },
];

describe('connection status', () => {
  it.each(CASES)(
    'As a dotli integrator, I ask whether a chain is up while it is $status and hear $up',
    ({ status, up }) => {
      // Given
      const current: ConnectionStatus = status;

      // When
      const answer = isChainUp(current);

      // Then
      expect(answer).toBe(up);
    },
  );
});
