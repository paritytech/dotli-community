// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A consumer and a serving transport, or a consumer and a raw peer the test speaks for, over one in-memory channel.

import { vi } from 'vitest';
import { manualTimers } from '@dotli/shared/testing';
import { createProviderPair } from '../provider.fake.js';
import type { Provider } from '../provider.js';
import { createConsumerTransport } from '../transport-consumer.js';
import { createServingTransport } from '../transport-serving.js';
import { decodeWireMessage, encodeWireMessage, type WireMessage } from '../wire-message.js';

export const RETRY_MS = 50;
export const TIMEOUT_MS = 5_000;

/** A consumer on the left and a serving transport on the right, over one in-memory channel. */
export function rig(options: { resolutionId?: string } = {}) {
  const { left, right, delivered } = createProviderPair();
  const timers = manualTimers();
  const count = vi.fn();
  const serving = createServingTransport(right, { side: 'frame', count });
  const consumer = createConsumerTransport(left, {
    side: 'host',
    timers,
    count,
    retryMs: RETRY_MS,
    timeoutMs: TIMEOUT_MS,
    ...options,
  });
  return { consumer, serving, timers, count, delivered, left };
}

/** A peer the test speaks for, message by message, in place of a transport. */
export function rawPeer(provider: Provider) {
  const heard: WireMessage[] = [];
  provider.subscribe(data => {
    const decoded = decodeWireMessage(data);
    if (decoded.ok) {
      heard.push(decoded.message);
    }
  });
  return {
    heard,
    send: (message: WireMessage) => {
      provider.post(encodeWireMessage(message));
    },
    legs: () => heard.map(message => `${message.leg}:${message.method}`),
  };
}

/** A consumer facing a raw peer, which answers nothing until the test says so. */
export function rawRig() {
  const { left, right } = createProviderPair();
  const timers = manualTimers();
  const count = vi.fn();
  const peer = rawPeer(right);
  const consumer = createConsumerTransport(left, {
    side: 'host',
    timers,
    count,
    retryMs: RETRY_MS,
    timeoutMs: TIMEOUT_MS,
  });
  const answerHandshake = (): void => {
    const hello = peer.heard.find(message => message.method === 'handshake');
    if (hello === undefined) {
      throw new Error('no handshake heard yet');
    }
    peer.send({ leg: 'response', id: hello.id, method: 'handshake', outcome: { ok: true, answer: undefined } });
  };
  return { consumer, timers, count, peer, left, right, answerHandshake };
}

export function decodedLegs(delivered: ArrayBuffer[]): string[] {
  return delivered.map(data => {
    const decoded = decodeWireMessage(data);
    return decoded.ok ? `${decoded.message.leg}:${decoded.message.method}` : 'refused';
  });
}

export async function outcomeOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    value => ({ value }),
    (error: unknown) => error,
  );
}
