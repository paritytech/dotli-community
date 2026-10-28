// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createChatConnections } from './createChatConnections.js';
import { createRecordingConnection } from './createChatConnections.fake.js';

const PRODUCT = 'chatty.dot';

describe('chat connections', () => {
  it('As a dotli integrator, I unregister a newer registration that failed and chat goes back to the connection still on screen', () => {
    // Given the product on screen, and a render of it that registered and then failed
    const connections = createChatConnections();
    const onScreen = createRecordingConnection();
    connections.register(PRODUCT, onScreen);
    const unregisterFailed = connections.register(PRODUCT, createRecordingConnection());

    // When
    unregisterFailed();

    // Then
    expect(connections.get(PRODUCT)).toBe(onScreen);
  });
});
