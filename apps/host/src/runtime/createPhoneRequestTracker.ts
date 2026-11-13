// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Temporary: the core does not report phone requests to the host, so this infers them from relayed frames. Remove once https://github.com/paritytech/trinity-user-agents/issues/1552 lands.

import { createDeferred } from '@dotli/shared';
import { decodeWireMessage, MESSAGE_TYPE_REQUEST, MESSAGE_TYPE_RESPONSE } from '@parity/truapi';
import { networkPause, type NetworkPause } from './createNetworkPause.js';
import { decodePhoneRequestBody, peekFrameHeader } from './phoneFrame.js';
import type { PhoneMethod } from './phoneMethods.js';
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
   * A throw reaches the tap that showed the frame.
   */
  reportUndecodable?: typeof reportUndecodablePhoneFrame;
  /** Decodes a tracked frame in full. Every other frame is only peeked at. */
  decode?: typeof decodeWireMessage;
  /** Keeps the network awake while a product's request to Polkadot App is in flight. */
  holdNetwork?: NetworkPause['hold'];
};

/**
 * A request in flight on an open tap, until its answer comes or its tap closes. `release` lets go of its network hold
 * and acts once.
 */
type Request =
  | { kind: 'tracked'; tap: symbol; requestId: string; request: PhoneRequest; release: () => void }
  | {
      kind: 'claimed';
      tap: symbol;
      requestId: string;
      request: PhoneRequest;
      release: () => void;
      settle: (outcome: PhoneOutcome) => void;
    };

/**
 * Builds the tracker of phone-bound requests in flight, read from the frames each connection's tap sees. Building it
 * never throws. A tracked frame that would not decode is reported, and a response that would not decode ends its claim
 * as `undecodable`.
 */
export function createPhoneRequestTracker({
  reportUndecodable = reportUndecodablePhoneFrame,
  decode = decodeWireMessage,
  holdNetwork = networkPause.hold,
}: Params = {}) {
  const taps = new Set<symbol>();
  // Oldest first, so the oldest is claimed first.
  let requests: readonly Request[] = [];
  let disposed = false;

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

  function connect() {
    const tap = Symbol('phone request tap');
    if (!disposed) {
      taps.add(tap);
    }
    return {
      /**
       * Tracks each phone-bound request the product sent to the core. A request that would not decode is reported.
       * Throws only when the network hold or the report throws.
       */
      fromProduct: (message: Uint8Array): void => {
        trackRequest(tap, message);
      },
      /**
       * Ends the claim each response the core sent answers. A response that would not decode ends it `undecodable`.
       * Throws only when the report throws.
       */
      fromCore: (message: Uint8Array): void => {
        answerRequest(tap, message);
      },
      /** Ends this connection's claims as `gone`. Idempotent, and never throws. */
      dispose: (): void => {
        taps.delete(tap);
        endRequests(request => request.tap === tap);
      },
    };
  }

  function trackRequest(tap: symbol, message: Uint8Array): void {
    if (!taps.has(tap)) {
      return;
    }
    const header = peekFrameHeader(message);
    if (header?.method === undefined || header.messageType !== MESSAGE_TYPE_REQUEST) {
      return;
    }
    const { requestId, method } = header;
    if (findRequest(tap, requestId) !== undefined) {
      return;
    }
    let request: PhoneRequest;
    try {
      request = { method, body: decodePhoneRequestBody(method, readPayload(message)) };
    } catch (error) {
      reportUndecodable({ method, error, leg: 'request' });
      return;
    }
    const release = holdNetwork();
    requests = [...requests, { kind: 'tracked', tap, requestId, request, release }];
  }

  function answerRequest(tap: symbol, message: Uint8Array): void {
    // Most frames answer no tracked request, so a tap that holds none skips the peek.
    if (!requests.some(request => request.tap === tap)) {
      return;
    }
    const header = peekFrameHeader(message);
    if (header?.messageType !== MESSAGE_TYPE_RESPONSE) {
      return;
    }
    const answered = findRequest(tap, header.requestId);
    if (answered === undefined || header.method !== answered.request.method) {
      return;
    }
    requests = requests.filter(request => request !== answered);
    answered.release();
    if (answered.kind === 'tracked') {
      return;
    }
    const { method } = answered.request;
    let outcome: PhoneOutcome;
    try {
      outcome = decodePhoneOutcome(method, readPayload(message));
    } catch (error) {
      answered.settle({ kind: 'undecodable' });
      reportUndecodable({ method, error, leg: 'response' });
      return;
    }
    answered.settle(outcome);
  }

  function claim(matches: (request: PhoneRequest) => boolean): PhoneClaim | undefined {
    const oldest = requests.find(request => request.kind === 'tracked' && matches(request.request));
    if (oldest === undefined) {
      return undefined;
    }
    const { promise, resolve: settle } = createDeferred<PhoneOutcome>();
    const claimed: Request = { ...oldest, kind: 'claimed', settle };
    requests = requests.map(request => (request === oldest ? claimed : request));
    return { request: oldest.request, ended: promise };
  }

  function dispose(): void {
    disposed = true;
    taps.clear();
    endRequests(() => true);
  }

  /** Ends the requests `ends` picks: each network hold is released, and a claimed one settles `gone`. */
  function endRequests(ends: (request: Request) => boolean): void {
    const ended = requests.filter(ends);
    requests = requests.filter(request => !ends(request));
    for (const request of ended) {
      request.release();
      if (request.kind === 'claimed') {
        request.settle({ kind: 'gone' });
      }
    }
  }

  /** The request `requestId` on `tap`, while it is in flight. */
  function findRequest(tap: symbol, requestId: string): Request | undefined {
    return requests.find(request => request.tap === tap && request.requestId === requestId);
  }

  /** The payload of a frame whose header was already peeked, so only a frame it cannot read fails. */
  function readPayload(message: Uint8Array): Uint8Array {
    const decoded = decode(message);
    if (decoded.isErr()) {
      throw decoded.error;
    }
    return decoded.value.payload.value;
  }
}
