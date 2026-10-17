// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { encodeWireMessage } from '../wire-message.js';
import { describeWireMessage } from './index.js';

describe('describeWireMessage', () => {
  it('As a test, I describe a recorded wire message as its method, leg and body', () => {
    // Given
    const data = encodeWireMessage({
      leg: 'event',
      id: 7,
      method: 'telemetry',
      event: { tag: 'smoldotDb', value: { chain: 'relay', outcome: 'miss' } },
    });

    // When
    const described = describeWireMessage(data);

    // Then
    expect(described).toEqual({
      method: 'telemetry',
      leg: 'event',
      id: 7,
      body: { event: { tag: 'smoldotDb', value: { chain: 'relay', outcome: 'miss' } } },
    });
  });

  it('As a test, I get null for data that is no wire message', () => {
    // Given
    const data = { namespace: 'dotli:protocol', kind: 'ready' };

    // When
    const described = describeWireMessage(data);

    // Then
    expect(described).toBeNull();
  });

  it('As a test, I read the bytes in a recorded wire message as hex, so the record stays plain JSON', () => {
    // Given
    const data = encodeWireMessage({
      leg: 'request',
      id: 1,
      method: 'localWalletSave',
      deadlineMs: null,
      payload: { siteId: 's', entropy: new Uint8Array([1, 2, 255]) },
    });

    // When
    const described = describeWireMessage(data);

    // Then
    expect(described?.body).toEqual({ deadlineMs: null, payload: { siteId: 's', entropy: '0x0102ff' } });
  });
});
