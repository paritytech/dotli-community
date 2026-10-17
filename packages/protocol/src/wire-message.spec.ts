// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { METHOD_NAMES, type ProtocolMethod } from './methods.js';
import { decodeWireMessage, encodeWireMessage, toWireError, type WireMessage } from './wire-message.js';

const identity = { identityAccountId: '5Grw', liteUsername: null };
const failure = { message: 'boom', name: 'TypeError', stack: null };

const requestSamples: Record<string, { payload: unknown; answer: unknown }> = {
  handshake: { payload: { version: 1, resolutionId: 'r1' }, answer: undefined },
  heartbeat: { payload: undefined, answer: undefined },
  warmup: { payload: undefined, answer: undefined },
  resolveOwner: { payload: { label: 'a' }, answer: '5Grw' },
  resolveExecutableManifest: {
    payload: { label: 'a', kind: 'worker' },
    answer: { kind: 'ok', value: { $v: 1, kind: 'app', appVersion: [1, 2, 3] }, raw: '{}' },
  },
  resolveRootManifest: { payload: { label: 'a' }, answer: { kind: 'empty' } },
  authStorageRead: { payload: { siteId: 's', key: 'k' }, answer: null },
  authStorageWrite: { payload: { siteId: 's', key: 'k', value: 'v' }, answer: undefined },
  authStorageClear: { payload: { siteId: 's', key: 'k' }, answer: undefined },
  modeStorageRead: { payload: { siteId: 's', key: 'k' }, answer: 'v' },
  modeStorageWrite: { payload: { siteId: 's', key: 'k', value: 'v' }, answer: undefined },
  modeStorageClear: { payload: { siteId: 's', key: 'k' }, answer: undefined },
  localWalletRead: {
    payload: { siteId: 's' },
    answer: { tag: 'ok', value: { entropy: new Uint8Array(32).fill(7), identity } },
  },
  localWalletSave: { payload: { siteId: 's', entropy: new Uint8Array(32).fill(1) }, answer: undefined },
  localWalletIdentity: { payload: { siteId: 's', identity }, answer: undefined },
  localWalletForget: { payload: { siteId: 's' }, answer: undefined },
  chainSend: { payload: { connectionId: 'c', message: 'm' }, answer: undefined },
};

const subscriptionSamples: Record<string, { payload: unknown; event: unknown }> = {
  frameStatus: { payload: undefined, event: undefined },
  telemetry: {
    payload: undefined,
    event: { tag: 'chainSync', value: { chain: 'relay', kind: 'peers', peers: 3 } },
  },
  sharedAuthChanges: { payload: undefined, event: { siteId: 's', key: 'k', value: null } },
  chainConnect: {
    payload: { genesisHash: '0x1', connectionId: 'c' },
    event: { tag: 'message', value: 'hello' },
  },
  resolveDotName: { payload: { label: 'a' }, event: { tag: 'phase', value: 'resolving-content' } },
};

function roundTrip(message: WireMessage): WireMessage {
  const decoded = decodeWireMessage(encodeWireMessage(message));
  if (!decoded.ok) {
    throw new Error(`refused as ${decoded.reason}`);
  }
  return decoded.message;
}

function telemetry(event: unknown): WireMessage {
  return { leg: 'event', id: 1, method: 'telemetry', event } as WireMessage;
}

describe('wire message', () => {
  it('As either side, I send every leg of every method and the other side reads the same message', () => {
    for (const method of METHOD_NAMES) {
      const request = requestSamples[method];
      const subscription = subscriptionSamples[method];
      const messages: unknown[] = [];
      if (request !== undefined) {
        messages.push(
          { leg: 'request', id: 4_000_000_000, method, deadlineMs: null, payload: request.payload },
          { leg: 'request', id: 2, method, deadlineMs: Date.now() + 90_000, payload: request.payload },
          { leg: 'response', id: 3, method, outcome: { ok: true, answer: request.answer } },
          { leg: 'response', id: 3, method, outcome: { ok: false, error: failure } },
        );
      }
      if (subscription !== undefined) {
        messages.push(
          { leg: 'subscribe', id: 5, method, deadlineMs: 1_700_000_000_000, payload: subscription.payload },
          { leg: 'event', id: 5, method, event: subscription.event },
          { leg: 'end', id: 5, method, error: null },
          { leg: 'end', id: 5, method, error: failure },
          { leg: 'unsubscribe', id: 5, method },
        );
      }
      expect(messages.length, `${method} has samples`).toBeGreaterThan(0);

      for (const sent of messages as WireMessage[]) {
        // Given
        const message = sent;

        // When
        const received = roundTrip(message);

        // Then
        expect(received).toEqual(message);
      }
    }
  });

  it('As the host, I drop telemetry a spoofed frame inflates', () => {
    // Given
    const peer = { peerId: 'p', roles: 'full', bestNumber: 1 };
    const inflated = [
      telemetry({ tag: 'chainDetail', value: { chain: 'relay', peers: Array.from({ length: 51 }, () => peer) } }),
      telemetry({ tag: 'chainDetail', value: { chain: 'relay', peers: [{ ...peer, peerId: 'x'.repeat(129) }] } }),
      telemetry({ tag: 'chainDetail', value: { chain: 'relay', peers: [{ ...peer, peerId: '' }] } }),
      telemetry({ tag: 'chainSync', value: { chain: 'relay', kind: 'peers', peers: 10_001 } }),
      telemetry({ tag: 'chainSync', value: { chain: 'relay', kind: 'peers' } }),
    ];

    for (const message of inflated) {
      // When
      const decoded = decodeWireMessage(encodeWireMessage(message));

      // Then
      expect(decoded).toEqual({ ok: false, reason: 'invalid' });
    }
  });

  it('As a receiver, I drop an unknown method id or leg as malformed', () => {
    // Given
    const good = new Uint8Array(encodeWireMessage({ leg: 'unsubscribe', id: 1, method: 'frameStatus' }));
    const badMethod = good.slice();
    badMethod[4] = METHOD_NAMES.length;
    const badLeg = good.slice();
    badLeg[5] = 6;
    const wrongKind = good.slice();
    wrongKind[4] = METHOD_NAMES.indexOf('warmup' satisfies ProtocolMethod);

    for (const bytes of [badMethod, badLeg, wrongKind]) {
      // When
      const decoded = decodeWireMessage(bytes.buffer);

      // Then
      expect(decoded).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('As a receiver, I drop a message one byte short or one byte long as malformed', () => {
    // Given
    const bytes = new Uint8Array(
      encodeWireMessage({ leg: 'request', id: 1, method: 'resolveOwner', deadlineMs: 5, payload: { label: 'abc' } }),
    );
    const longer = new Uint8Array(bytes.length + 1);
    longer.set(bytes);

    // When
    const short = decodeWireMessage(bytes.slice(0, -1).buffer);
    const long = decodeWireMessage(longer.buffer);

    // Then
    expect(short).toEqual({ ok: false, reason: 'malformed' });
    expect(long).toEqual({ ok: false, reason: 'malformed' });
  });

  it('As a sender, I cannot encode an id or deadline the wire would distort', () => {
    // Given
    const base = { leg: 'request', method: 'warmup', payload: undefined } as const;

    // When / Then
    expect(() => encodeWireMessage({ ...base, id: 1, deadlineMs: 1.5 })).toThrow(RangeError);
    expect(() => encodeWireMessage({ ...base, id: 2 ** 32, deadlineMs: null })).toThrow(RangeError);
  });

  it('As a sender, I keep at most 2000 characters of a stack', () => {
    // Given
    const error = new Error('boom');
    error.stack = 'x'.repeat(5000);

    // When
    const wire = toWireError(error);

    // Then
    expect(wire.message).toBe('boom');
    expect(wire.name).toBe('Error');
    expect(wire.stack).toHaveLength(2000);
    expect(toWireError('plain').stack).toBeNull();
  });
});
