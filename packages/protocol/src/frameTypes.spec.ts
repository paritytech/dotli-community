// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { isFrameDown, isFrameReady, type ProtocolStatus } from './frameTypes.js';

const CASES: { status: ProtocolStatus; down: boolean; ready: boolean }[] = [
  { status: 'idle', down: false, ready: false },
  { status: 'booting', down: false, ready: false },
  { status: 'listening', down: false, ready: false },
  { status: 'ready', down: false, ready: true },
  { status: 'failed', down: true, ready: false },
];

describe('frame status', () => {
  it.each(CASES)(
    'As the host, I ask whether the frame is down while it is $status and hear $down',
    ({ status, down }) => {
      // Given
      const current: ProtocolStatus = status;

      // When
      const answer = isFrameDown(current);

      // Then
      expect(answer).toBe(down);
    },
  );

  it.each(CASES)(
    'As the host, I ask whether the frame is ready while it is $status and hear $ready',
    ({ status, ready }) => {
      // Given
      const current: ProtocolStatus = status;

      // When
      const answer = isFrameReady(current);

      // Then
      expect(answer).toBe(ready);
    },
  );
});
