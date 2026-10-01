// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi, type Mock } from 'vitest';
import type { JsonRpcConnection, JsonRpcMessage, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import type { InnerJsonRpcProvider } from '@polkadot-api/json-rpc-provider-proxy';
import { createPauseController } from '../src/pause-controller.js';

interface Invocation {
  onMessage: (message: JsonRpcMessage) => void;
  send: Mock<(message: JsonRpcRequest) => void>;
  disconnect: Mock<() => void>;
}

/** A base provider that records each invocation the controller makes of it. */
function createBase(): { base: Mock<InnerJsonRpcProvider>; invocations: Invocation[] } {
  const invocations: Invocation[] = [];
  const base = vi.fn<InnerJsonRpcProvider>((onMessage): JsonRpcConnection => {
    const invocation: Invocation = {
      onMessage,
      send: vi.fn<(message: JsonRpcRequest) => void>(),
      disconnect: vi.fn<() => void>(),
    };
    invocations.push(invocation);
    return { send: invocation.send, disconnect: invocation.disconnect };
  });
  return { base, invocations };
}

function request(id: number): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method: 'test_method', params: [] };
}

function at<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`missing item ${String(index)}`);
  }
  return item;
}

describe('pause-controller', () => {
  it('As a dotli integrator, a connection paused before it opens opens nothing and buffers sends until resume', () => {
    // Given
    const { base, invocations } = createBase();
    const controller = createPauseController();
    const provider = controller.middleware(base);
    controller.pause();

    // When
    const connection = provider(vi.fn(), vi.fn());
    connection.send(request(1));
    connection.send(request(2));

    // Then
    expect(base).not.toHaveBeenCalled();

    // When
    controller.resume();

    // Then
    expect(base).toHaveBeenCalledTimes(1);
    expect(at(invocations, 0).send.mock.calls).toEqual([[request(1)], [request(2)]]);
  });

  it('As a dotli integrator, pausing a live connection closes its socket, reports one halt and buffers later sends', () => {
    // Given
    const { base, invocations } = createBase();
    const controller = createPauseController();
    const onHalt = vi.fn<(error?: unknown) => void>();
    const connection = controller.middleware(base)(vi.fn(), onHalt);
    const live = at(invocations, 0);

    // When
    controller.pause();
    controller.pause();
    connection.send(request(1));

    // Then
    expect(live.disconnect).toHaveBeenCalledTimes(1);
    expect(onHalt).toHaveBeenCalledTimes(1);
    expect(onHalt).toHaveBeenCalledWith({ type: 'paused' });
    expect(live.send).not.toHaveBeenCalled();
  });

  it('As a dotli integrator, resume after a halt opens the connection the proxy re-invoked, not the stale one', () => {
    // Given
    const { base, invocations } = createBase();
    const controller = createPauseController();
    const provider = controller.middleware(base);
    provider(vi.fn(), vi.fn());
    controller.pause();
    const connection = provider(vi.fn(), vi.fn());
    connection.send(request(1));
    expect(base).toHaveBeenCalledTimes(1);

    // When
    controller.resume();

    // Then
    expect(base).toHaveBeenCalledTimes(2);
    expect(at(invocations, 0).send).not.toHaveBeenCalled();
    expect(at(invocations, 1).send.mock.calls).toEqual([[request(1)]]);
  });

  it('As a dotli integrator, disconnecting clears the buffer and pause state until the middleware is invoked again', () => {
    // Given
    const { base, invocations } = createBase();
    const controller = createPauseController();
    const provider = controller.middleware(base);
    controller.pause();
    const connection = provider(vi.fn(), vi.fn());
    connection.send(request(1));

    // When
    connection.disconnect();
    controller.resume();
    controller.pause();
    controller.resume();

    // Then
    expect(base).not.toHaveBeenCalled();

    // When
    provider(vi.fn(), vi.fn());

    // Then
    expect(base).toHaveBeenCalledTimes(1);
    expect(at(invocations, 0).send).not.toHaveBeenCalled();
  });
});
