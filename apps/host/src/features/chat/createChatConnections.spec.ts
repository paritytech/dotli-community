// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createChatConnections, type ChatConnection } from './createChatConnections.js';
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

  it('As a dotli integrator, I run a stale unregister after a newer registration and the newer connection still answers', () => {
    // Given
    const connections = createChatConnections();
    const unregisterOld = connections.register(PRODUCT, createRecordingConnection());
    const fresh = createRecordingConnection();
    connections.register(PRODUCT, fresh);

    // When
    unregisterOld();

    // Then
    expect(connections.get(PRODUCT)).toBe(fresh);
  });

  it('As the chat store, I listen for registrations and hear each with its product once it is the newest', () => {
    // Given a listener that reads the newest connection as it hears
    const connections = createChatConnections();
    const heard: { productId: string; newest: ChatConnection | undefined }[] = [];
    connections.onRegister(productId => {
      heard.push({ productId, newest: connections.get(productId) });
    });
    const connection = createRecordingConnection();

    // When
    connections.register(PRODUCT, connection);

    // Then
    expect(heard).toEqual([{ productId: PRODUCT, newest: connection }]);
  });
});
