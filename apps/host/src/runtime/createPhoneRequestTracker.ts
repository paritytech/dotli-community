// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Temporary: the core does not report phone requests to the host, so this infers them from relayed frames. Remove once https://github.com/paritytech/trinity-user-agents/issues/1552 lands.

import { getKeys, isRecord } from '@dotli/shared';
import { decodeWireMessage, MESSAGE_TYPE_REQUEST, MESSAGE_TYPE_RESPONSE } from '@parity/truapi';
import { compact } from '@parity/truapi/scale';
import { PHONE_METHODS, type PhoneMethod } from './phoneMethods.js';
import { decodePhoneOutcome, type PhoneOutcome } from './phoneOutcome.js';
import { reportUndecodablePhoneFrame } from './phoneReport.js';

/** A phone-bound request in flight, with its V1 request body as `@parity/truapi` decodes it. */
export type PhoneRequest = {
  method: PhoneMethod;
  /** The unwrapped V1 value of the method's `Versioned...Request` codec. */
  body: unknown;
};

export type PhoneClaim = {
  request: PhoneRequest;
  /** Settles once with how the request ended. Never rejects. */
  ended: Promise<PhoneOutcome>;
};

export type PhoneRequestTracker = ReturnType<typeof createPhoneRequestTracker>;

type Params = {
  /**
   * Reports a tracked frame that would not decode. A response ends its claim as `undecodable`, which the claim counts.
   * Must not throw.
   */
  reportUndecodable?: typeof reportUndecodablePhoneFrame;
  /** Decodes a tracked frame in full. Every other frame is only peeked at. */
  decode?: typeof decodeWireMessage;
};

type FrameHeader = {
  requestId: string;
  /** Undefined for a method that does not go to the phone. */
  method: PhoneMethod | undefined;
  messageType: number;
};

type Tracked = {
  /** The order the request was tracked in, so the oldest is claimed first. */
  sequence: number;
  request: PhoneRequest;
  /** Set once claimed, and settles the claim. */
  settle: ((outcome: PhoneOutcome) => void) | undefined;
};

const METHOD_AT = new Map<number, PhoneMethod>(
  getKeys(PHONE_METHODS).map(method => {
    const { ids } = PHONE_METHODS[method];
    return [(ids.trait << 8) | ids.method, method];
  }),
);

const UTF8 = new TextDecoder();

/** The bytes of a SCALE compact prefix by its mode, the low two bits. The big-integer mode never prefixes a frame. */
const COMPACT_PREFIX_BYTES = [1, 2, 4] as const;

/**
 * Builds the tracker of phone-bound requests in flight, read from the frames each connection's tap sees. Building it
 * never throws. A tracked frame that would not decode is reported, and a response that would not decode ends its claim
 * as `undecodable`.
 */
export function createPhoneRequestTracker({
  reportUndecodable = reportUndecodablePhoneFrame,
  decode = decodeWireMessage,
}: Params = {}) {
  const taps = new Set<Map<string, Tracked>>();
  let sequence = 0;
  let disposed = false;

  function endAll(inflight: Map<string, Tracked>): void {
    const ended = [...inflight.values()];
    inflight.clear();
    for (const tracked of ended) {
      tracked.settle?.({ kind: 'gone' });
    }
  }

  /** The payload of a frame whose header was already peeked, so only a frame it cannot read fails. */
  function readPayload(message: Uint8Array): Uint8Array {
    const decoded = decode(message);
    if (decoded.isErr()) {
      throw decoded.error;
    }
    return decoded.value.payload.value;
  }

  function connect() {
    const inflight = new Map<string, Tracked>();
    let closed = disposed;
    if (!disposed) {
      taps.add(inflight);
    }

    function fromProduct(message: Uint8Array): void {
      if (closed || disposed) {
        return;
      }
      const header = peekHeader(message);
      if (
        header?.method === undefined ||
        header.messageType !== MESSAGE_TYPE_REQUEST ||
        inflight.has(header.requestId)
      ) {
        return;
      }
      const { requestId } = header;
      const method = header.method;
      try {
        const body = unwrapV1(PHONE_METHODS[method].request.dec(readPayload(message)));
        inflight.set(requestId, { sequence: sequence++, request: { method, body }, settle: undefined });
      } catch (error) {
        reportUndecodable({ method, error, leg: 'request' });
      }
    }

    function fromCore(message: Uint8Array): void {
      // A closed tap has already ended its claims and emptied its map, so this covers it too.
      if (inflight.size === 0) {
        return;
      }
      const header = peekHeader(message);
      if (header?.messageType !== MESSAGE_TYPE_RESPONSE) {
        return;
      }
      const tracked = inflight.get(header.requestId);
      if (tracked === undefined || header.method !== tracked.request.method) {
        return;
      }
      inflight.delete(header.requestId);
      if (tracked.settle === undefined) {
        return;
      }
      try {
        tracked.settle(decodePhoneOutcome(tracked.request.method, readPayload(message)));
      } catch (error) {
        reportUndecodable({ method: tracked.request.method, error, leg: 'response' });
        tracked.settle({ kind: 'undecodable' });
      }
    }

    function disposeTap(): void {
      closed = true;
      taps.delete(inflight);
      endAll(inflight);
    }

    return {
      /** Tracks each phone-bound request the product sent to the core. A request that would not decode is reported. */
      fromProduct,
      /** Ends the claim each response the core sent answers. A response that would not decode ends it `undecodable`. */
      fromCore,
      /** Ends this connection's claims as `gone`. Idempotent, and never throws. */
      dispose: disposeTap,
    };
  }

  function claim(matches: (request: PhoneRequest) => boolean): PhoneClaim | undefined {
    let oldest: Tracked | undefined;
    for (const inflight of taps) {
      for (const tracked of inflight.values()) {
        if (
          tracked.settle === undefined &&
          (oldest === undefined || tracked.sequence < oldest.sequence) &&
          matches(tracked.request)
        ) {
          oldest = tracked;
        }
      }
    }
    if (oldest === undefined) {
      return undefined;
    }
    const claimed = oldest;
    const ended = new Promise<PhoneOutcome>(resolve => {
      claimed.settle = resolve;
    });
    return { request: claimed.request, ended };
  }

  function dispose(): void {
    disposed = true;
    for (const inflight of taps) {
      endAll(inflight);
    }
    taps.clear();
  }

  return {
    /** Opens a tap on one connection's frames, already closed once the tracker is disposed. Never throws. */
    connect,
    /**
     * The oldest unclaimed in-flight request that `matches`, now claimed, or undefined. Throws only when `matches`
     * does.
     */
    claim,
    /** Ends every claim as `gone`. Idempotent, and never throws. */
    dispose,
  };
}

/**
 * A frame's header without copying its payload: `[requestId: compact length + UTF-8][trait][method][messageType]`.
 * Undefined for a frame too short to have one, which the core reports itself since the tap is passive.
 */
function peekHeader(message: Uint8Array): FrameHeader | undefined {
  const first = message[0];
  const prefix = first === undefined ? undefined : COMPACT_PREFIX_BYTES[first & 0b11];
  if (prefix === undefined || message.length < prefix) {
    return undefined;
  }
  // A copy of the prefix only, as the codec reads from the start of a view's whole buffer.
  const end = prefix + Number(compact.dec(message.slice(0, prefix)));
  const traitId = message[end];
  const methodId = message[end + 1];
  const messageType = message[end + 2];
  if (traitId === undefined || methodId === undefined || messageType === undefined) {
    return undefined;
  }
  return {
    requestId: UTF8.decode(message.subarray(prefix, end)),
    method: METHOD_AT.get((traitId << 8) | methodId),
    messageType,
  };
}

/** The V1 value of a decoded `Versioned...Request`. Throws for any other version. */
function unwrapV1(versioned: unknown): unknown {
  const version = isRecord(versioned) ? versioned['tag'] : undefined;
  if (!isRecord(versioned) || version !== 'V1') {
    throw new Error(`unsupported request version ${String(version)}`);
  }
  return versioned['value'];
}
