// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { bindCaptureSink } from '@dotli/metrics';
import { describe, expect, it, onTestFinished } from 'vitest';
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

  it('As the chat store, I unsubscribe and hear no later registration', () => {
    // Given
    const connections = createChatConnections();
    const heard: string[] = [];
    const unsubscribe = connections.onRegister(productId => heard.push(productId));

    // When
    unsubscribe();
    connections.register(PRODUCT, createRecordingConnection());

    // Then
    expect(heard).toEqual([]);
  });

  it('As a dotli integrator, I register while a listener throws and the registration stands while the others hear it and the failure is reported', () => {
    // Given a throwing listener ahead of a recording one
    const captured: string[] = [];
    onTestFinished(
      bindCaptureSink({
        exception: (_error: unknown, context: { step: string }) => {
          captured.push(context.step);
        },
        expected: () => undefined,
      }),
    );
    const connections = createChatConnections();
    connections.onRegister(() => {
      throw new Error('broken listener');
    });
    const heard: string[] = [];
    connections.onRegister(productId => heard.push(productId));
    const connection = createRecordingConnection();

    // When
    connections.register(PRODUCT, connection);

    // Then
    expect(connections.get(PRODUCT)).toBe(connection);
    expect(heard).toEqual([PRODUCT]);
    expect(captured).toEqual(['listener']);
  });
});
