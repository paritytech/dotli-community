// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Temporary: the core does not report phone requests to the host, so this infers them from relayed frames. Remove once https://github.com/paritytech/trinity-user-agents/issues/1552 lands.

import { decodeWireMessage, MESSAGE_TYPE_REQUEST, MESSAGE_TYPE_RESPONSE } from '@parity/truapi';
import { compact } from '@parity/truapi/scale';
import { PHONE_METHODS, type PhoneMethod } from './phone-methods.js';
import { decodePhoneOutcome, type PhoneOutcome } from './phone-outcome.js';
import { reportUndecodablePhoneFrame, type PhoneLeg } from './phone-report.js';

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

export type PhoneRequestTap = {
  /** Each frame the product sent to the core. */
  fromProduct: (message: Uint8Array) => void;
  /** Each frame the core sent to the product. */
  fromCore: (message: Uint8Array) => void;
  /** Ends this connection's claims as `gone`. Idempotent. */
  close: () => void;
};

export type PhoneRequestTracker = {
  connect: () => PhoneRequestTap;
  /** The oldest unclaimed in-flight request that `matches`, now claimed, or undefined. */
  claim: (matches: (request: PhoneRequest) => boolean) => PhoneClaim | undefined;
  /** Ends every claim as `gone`. Idempotent. */
  dispose: () => void;
};

export type PhoneRequestTrackerDeps = {
  /** A tracked frame that would not decode. A response ends its claim as `undecodable`, which the claim counts. */
  reportUndecodable?: (method: PhoneMethod, error: unknown, leg: PhoneLeg) => void;
  /** Decodes a tracked frame in full. Every other frame is only peeked at. */
  decode?: typeof decodeWireMessage;
};

const METHOD_AT = new Map<number, PhoneMethod>(
  (Object.keys(PHONE_METHODS) as PhoneMethod[]).map(method => {
    const { ids } = PHONE_METHODS[method];
    return [(ids.trait << 8) | ids.method, method];
  }),
);

type FrameHeader = {
  requestId: string;
  /** Undefined for a method that does not go to the phone. */
  method: PhoneMethod | undefined;
  messageType: number;
};

const UTF8 = new TextDecoder();

/** The bytes of a SCALE compact prefix by its mode, the low two bits. The big-integer mode never prefixes a frame. */
const COMPACT_PREFIX_BYTES = [1, 2, 4] as const;

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

type Tracked = {
  seq: number;
  request: PhoneRequest;
  /** Set once claimed, and settles the claim. */
  settle: ((outcome: PhoneOutcome) => void) | undefined;
};

export function createPhoneRequestTracker({
  reportUndecodable = reportUndecodablePhoneFrame,
  decode = decodeWireMessage,
}: PhoneRequestTrackerDeps = {}): PhoneRequestTracker {
  const taps = new Set<Map<string, Tracked>>();
  let seq = 0;
  let disposed = false;

  const endAll = (inflight: Map<string, Tracked>): void => {
    const ended = [...inflight.values()];
    inflight.clear();
    for (const tracked of ended) {
      tracked.settle?.({ kind: 'gone' });
    }
  };

  /** The payload of a frame whose header was already peeked, so only a frame it cannot read fails. */
  const payloadOf = (message: Uint8Array): Uint8Array => {
    const decoded = decode(message);
    if (decoded.isErr()) {
      throw decoded.error;
    }
    return decoded.value.payload.value;
  };

  return {
    connect() {
      const inflight = new Map<string, Tracked>();
      let closed = disposed;
      if (!disposed) {
        taps.add(inflight);
      }

      return {
        fromProduct(message) {
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
            const versioned = PHONE_METHODS[method].request.dec(payloadOf(message)) as { tag: string; value: unknown };
            if (versioned.tag !== 'V1') {
              throw new Error(`unsupported request version ${versioned.tag}`);
            }
            inflight.set(requestId, { seq: seq++, request: { method, body: versioned.value }, settle: undefined });
          } catch (error) {
            reportUndecodable(method, error, 'request');
          }
        },
        fromCore(message) {
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
            tracked.settle(decodePhoneOutcome(tracked.request.method, payloadOf(message)));
          } catch (error) {
            reportUndecodable(tracked.request.method, error, 'response');
            tracked.settle({ kind: 'undecodable' });
          }
        },
        close() {
          closed = true;
          taps.delete(inflight);
          endAll(inflight);
        },
      };
    },

    claim(matches) {
      let oldest: Tracked | undefined;
      for (const inflight of taps) {
        for (const tracked of inflight.values()) {
          if (
            tracked.settle === undefined &&
            (oldest === undefined || tracked.seq < oldest.seq) &&
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
    },

    dispose() {
      disposed = true;
      for (const inflight of taps) {
        endAll(inflight);
      }
      taps.clear();
    },
  };
}
