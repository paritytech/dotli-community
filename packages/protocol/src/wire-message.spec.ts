// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  METHOD_NAMES,
  PROTOCOL_METHODS,
  type Answer,
  type ProtocolMethod,
  type RequestPayload,
  type SubscribePayload,
  type SubscriptionEvent,
  type SubscriptionMethod,
} from './methods.js';
import {
  decodeWireMessage,
  encodeWireMessage,
  toWireError,
  type EventMessage,
  type Requestable,
  type RequestMessage,
  type ResponseMessage,
  type SubscribeMessage,
  type WireMessage,
} from './wire-message.js';

const identity = { identityAccountId: '5Grw', liteUsername: null };
const failure = { message: 'boom', name: 'TypeError', stack: null };

const requestSamples: { [M in Requestable]: { payload: RequestPayload<M>; answer: Answer<M> } } = {
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

const subscriptionSamples: {
  [M in SubscriptionMethod]: { payload: SubscribePayload<M>; event: SubscriptionEvent<M> };
} = {
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
  beat: { payload: undefined, event: undefined },
};

function isRequestable(method: ProtocolMethod): method is Requestable {
  return PROTOCOL_METHODS[method].kind === 'request';
}

/** A message as sent, and its encoding, which the encoder holds to the message's method. */
interface Sample {
  message: unknown;
  encode: () => ArrayBuffer;
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- M types the samples, not the result
function requestSamplesOf<M extends Requestable>(method: M): Sample[] {
  const { payload, answer } = requestSamples[method];
  const messages: (RequestMessage<M> | ResponseMessage<M>)[] = [
    { leg: 'request', id: 4_000_000_000, method, deadlineMs: null, payload },
    { leg: 'request', id: 2, method, deadlineMs: 1_700_000_090_000, payload },
    { leg: 'response', id: 3, method, outcome: { ok: true, answer } },
    { leg: 'response', id: 3, method, outcome: { ok: false, error: failure } },
  ];
  return messages.map(message => ({ message, encode: () => encodeWireMessage(message) }));
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- M types the samples, not the result
function subscriptionSamplesOf<M extends SubscriptionMethod>(method: M): Sample[] {
  const { payload, event } = subscriptionSamples[method];
  const opening: (SubscribeMessage<M> | EventMessage<M>)[] = [
    { leg: 'subscribe', id: 5, method, deadlineMs: 1_700_000_000_000, payload },
    { leg: 'event', id: 5, method, event },
  ];
  const closing: WireMessage[] = [
    { leg: 'end', id: 5, method, error: null },
    { leg: 'end', id: 5, method, error: failure },
    { leg: 'unsubscribe', id: 5, method },
  ];
  return [
    ...opening.map(message => ({ message, encode: () => encodeWireMessage(message) })),
    ...closing.map(message => ({ message, encode: () => encodeWireMessage(message) })),
  ];
}

function telemetry(event: SubscriptionEvent<'telemetry'>): WireMessage {
  return { leg: 'event', id: 1, method: 'telemetry', event };
}

// Offsets into the header (u32 id, u8 method, u8 leg) and the response's outcome tag after it.
const METHOD_BYTE = 4;
const LEG_BYTE = 5;
const OUTCOME_BYTE = 6;

/** A valid message whose byte at `index` is then set to `value`. */
function withByte(message: WireMessage, index: number, value: number): ArrayBuffer {
  const bytes = new Uint8Array(encodeWireMessage(message));
  bytes[index] = value;
  return bytes.buffer;
}

describe('wire message', () => {
  it('As either side, I send every leg of every method and the other side reads the same message', () => {
    for (const method of METHOD_NAMES) {
      // Given
      const samples = isRequestable(method) ? requestSamplesOf(method) : subscriptionSamplesOf(method);

      for (const { message, encode } of samples) {
        // When
        const received = decodeWireMessage(encode());

        // Then
        expect(received).toEqual({ ok: true, message });
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
      expect(decoded).toEqual({
        ok: false,
        reason: 'invalid',
        cause: new RangeError('a telemetry event fails its check'),
      });
    }
  });

  it('As a receiver, I drop an unknown method id or leg as malformed, with what failed', () => {
    // Given
    const unsubscribe: WireMessage = { leg: 'unsubscribe', id: 1, method: 'frameStatus' };
    const refused = [
      withByte(unsubscribe, METHOD_BYTE, METHOD_NAMES.length),
      withByte(unsubscribe, LEG_BYTE, 6),
      withByte(unsubscribe, METHOD_BYTE, METHOD_NAMES.indexOf('warmup' satisfies ProtocolMethod)),
    ];

    for (const data of refused) {
      // When
      const decoded = decodeWireMessage(data);

      // Then
      expect(decoded).toMatchObject({ ok: false, reason: 'malformed' });
      expect(decoded.ok ? null : decoded.cause).toBeInstanceOf(Error);
    }
  });

  it('As a receiver, I drop a response whose outcome is neither an answer nor an error as malformed', () => {
    // Given
    const response: WireMessage = {
      leg: 'response',
      id: 1,
      method: 'heartbeat',
      outcome: { ok: true, answer: undefined },
    };

    // When
    const decoded = decodeWireMessage(withByte(response, OUTCOME_BYTE, 2));

    // Then
    expect(decoded).toEqual({ ok: false, reason: 'malformed', cause: new RangeError('unknown outcome 2') });
  });

  it('As a receiver, I drop a request leg on a subscription method as malformed', () => {
    // Given
    const request: WireMessage = { leg: 'request', id: 1, method: 'heartbeat', deadlineMs: null, payload: undefined };
    const subscriptionMethod = METHOD_NAMES.indexOf('frameStatus' satisfies SubscriptionMethod);

    // When
    const decoded = decodeWireMessage(withByte(request, METHOD_BYTE, subscriptionMethod));

    // Then
    expect(decoded).toEqual({
      ok: false,
      reason: 'malformed',
      cause: new TypeError('a request leg does not belong to a subscription method'),
    });
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
    expect(short).toMatchObject({ ok: false, reason: 'malformed' });
    expect(long).toMatchObject({ ok: false, reason: 'malformed' });
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
