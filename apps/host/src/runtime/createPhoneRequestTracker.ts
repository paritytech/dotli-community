// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Temporary: the core does not report phone requests to the host, so this infers them from relayed frames. Remove once https://github.com/paritytech/trinity-user-agents/issues/1552 lands.

import { createReporter, defineCount } from '@dotli/metrics';
import { createDeferred, createStateMachine, type MachineTypes, type Transition } from '@dotli/shared';
import { decodeWireMessage, MESSAGE_TYPE_REQUEST, MESSAGE_TYPE_RESPONSE } from '@parity/truapi';
import { networkPause, type NetworkPause } from './createNetworkPause.js';
import { decodePhoneRequestBody, peekFrameHeader } from './phoneFrame.js';
import type { PhoneMethod } from './phoneMethods.js';
import { decodePhoneOutcome, type PhoneOutcome } from './phoneOutcome.js';
import { reportUndecodablePhoneFrame, type PhoneLeg } from './phoneReport.js';

const report = createReporter({ flow: 'wallet' });

/** A transition of the tracker that threw. */
const phoneTrackerTransitionMetric = defineCount<'error'>('signing.phone_tracker_transition');

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
  /** Keeps the network awake while a product's request to Polkadot App is in flight. */
  holdNetwork?: NetworkPause['hold'];
};

/** One connection's tap, told apart by identity. */
type TapId = symbol;

type Settle = (outcome: PhoneOutcome) => void;

/**
 * A request in flight on an open tap, until its answer comes or its tap closes. `release` lets go of its network hold
 * and acts once.
 */
type Request =
  | { kind: 'tracked'; tap: TapId; requestId: string; request: PhoneRequest; release: () => void }
  | { kind: 'claimed'; tap: TapId; requestId: string; request: PhoneRequest; release: () => void; settle: Settle };

/** `requests` runs oldest first, so the oldest is claimed first. */
type TrackerState = { kind: 'live'; taps: ReadonlySet<TapId>; requests: readonly Request[] } | { kind: 'disposed' };

type TrackerEvent =
  | { kind: 'tapOpened'; tap: TapId }
  | { kind: 'productFrame'; tap: TapId; message: Uint8Array }
  | { kind: 'coreFrame'; tap: TapId; message: Uint8Array }
  | { kind: 'claimed'; tap: TapId; requestId: string; settle: Settle }
  // The claimer gave up on its claim made inside a transition, which has no holder to settle it.
  | { kind: 'claimDropped'; settle: Settle }
  | { kind: 'tapClosed'; tap: TapId }
  | { kind: 'disposed' };

type TrackerEffect =
  | { kind: 'released'; release: () => void }
  | { kind: 'settled'; settle: Settle; outcome: PhoneOutcome }
  | { kind: 'undecodable'; method: PhoneMethod; error: unknown; leg: PhoneLeg };

type TrackerMachine = MachineTypes<TrackerState, TrackerEvent, TrackerEffect>;

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
  const machine = createStateMachine<TrackerMachine>({
    initial: { kind: 'live', taps: new Set(), requests: [] },
    handlers: {
      live: {
        tapOpened(state, { tap }, { emitState }) {
          emitState({ ...state, taps: new Set(state.taps).add(tap) });
        },
        productFrame(state, { tap, message }, { emitState, emitSideEffect }) {
          if (!state.taps.has(tap)) {
            return;
          }
          const header = peekFrameHeader(message);
          if (header?.method === undefined || header.messageType !== MESSAGE_TYPE_REQUEST) {
            return;
          }
          const { requestId, method } = header;
          if (findRequest(state, tap, requestId) !== undefined) {
            return;
          }
          try {
            const request = { method, body: decodePhoneRequestBody(method, readPayload(message)) };
            const release = holdNetwork();
            emitState({
              ...state,
              requests: [...state.requests, { kind: 'tracked', tap, requestId, request, release }],
            });
          } catch (error) {
            emitSideEffect({ kind: 'undecodable', method, error, leg: 'request' });
          }
        },
        coreFrame(state, { tap, message }, { emitState, emitSideEffect }) {
          // Most frames answer no tracked request, so a tap that holds none skips the peek.
          if (!state.requests.some(request => request.tap === tap)) {
            return;
          }
          const header = peekFrameHeader(message);
          if (header?.messageType !== MESSAGE_TYPE_RESPONSE) {
            return;
          }
          const answered = findRequest(state, tap, header.requestId);
          if (answered === undefined || header.method !== answered.request.method) {
            return;
          }
          emitState({ ...state, requests: state.requests.filter(request => request !== answered) });
          emitSideEffect({ kind: 'released', release: answered.release });
          if (answered.kind === 'tracked') {
            return;
          }
          const { method } = answered.request;
          try {
            const outcome = decodePhoneOutcome(method, readPayload(message));
            emitSideEffect({ kind: 'settled', settle: answered.settle, outcome });
          } catch (error) {
            emitSideEffect({ kind: 'settled', settle: answered.settle, outcome: { kind: 'undecodable' } });
            emitSideEffect({ kind: 'undecodable', method, error, leg: 'response' });
          }
        },
        claimed(state, { tap, requestId, settle }, { emitState }) {
          const request = findRequest(state, tap, requestId);
          if (request?.kind !== 'tracked') {
            return;
          }
          const claimed: Request = { ...request, kind: 'claimed', settle };
          emitState({ ...state, requests: state.requests.map(held => (held === request ? claimed : held)) });
        },
        claimDropped(state, { settle }, { emitState }) {
          const request = findClaim(state, settle);
          if (request === undefined) {
            return;
          }
          const tracked: Request = {
            kind: 'tracked',
            tap: request.tap,
            requestId: request.requestId,
            request: request.request,
            release: request.release,
          };
          emitState({ ...state, requests: state.requests.map(held => (held === request ? tracked : held)) });
        },
        tapClosed(state, { tap }, transition) {
          const taps = new Set(state.taps);
          taps.delete(tap);
          transition.emitState({ ...state, taps, requests: state.requests.filter(request => request.tap !== tap) });
          endRequests(
            state.requests.filter(request => request.tap === tap),
            transition,
          );
        },
        disposed({ requests }, _event, transition) {
          transition.emitState({ kind: 'disposed' });
          endRequests(requests, transition);
        },
      },
      disposed: null,
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'released':
          effect.release();
          return;
        case 'settled':
          effect.settle(effect.outcome);
          return;
        case 'undecodable':
          reportUndecodable({ method: effect.method, error: effect.error, leg: effect.leg });
          return;
      }
    },
    onError: error => {
      report.defect(error, {
        step: 'phone_tracker_transition',
        metric: phoneTrackerTransitionMetric,
        message: '[dot.li phone request] A transition of the tracker threw:',
      });
    },
  });

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
    const tap: TapId = Symbol('phone request tap');
    machine.update({ kind: 'tapOpened', tap });

    function fromProduct(message: Uint8Array): void {
      machine.update({ kind: 'productFrame', tap, message });
    }

    function fromCore(message: Uint8Array): void {
      machine.update({ kind: 'coreFrame', tap, message });
    }

    function closeTap(): void {
      machine.update({ kind: 'tapClosed', tap });
    }

    return {
      /** Tracks each phone-bound request the product sent to the core. A request that would not decode is reported. */
      fromProduct,
      /** Ends the claim each response the core sent answers. A response that would not decode ends it `undecodable`. */
      fromCore,
      /** Ends this connection's claims as `gone`. Idempotent, and never throws. */
      dispose: closeTap,
    };
  }

  function claim(matches: (request: PhoneRequest) => boolean): PhoneClaim | undefined {
    const state = machine.state.get();
    const oldest =
      state.kind === 'live'
        ? state.requests.find(request => request.kind === 'tracked' && matches(request.request))
        : undefined;
    if (oldest === undefined) {
      return undefined;
    }
    const { tap, requestId, request } = oldest;
    const { promise, resolve: settle } = createDeferred<PhoneOutcome>();
    machine.update({ kind: 'claimed', tap, requestId, settle });
    // A claim made inside a tracker transition has its event run after this returns, so it holds nothing yet. It
    // returns no claim, and drops it in an event that runs right after the claim's, so the request stays claimable.
    const now = machine.state.get();
    if (now.kind !== 'live' || findClaim(now, settle) === undefined) {
      machine.update({ kind: 'claimDropped', settle });
      return undefined;
    }
    return { request, ended: promise };
  }

  function dispose(): void {
    machine.update({ kind: 'disposed' });
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

/** The request `requestId` on `tap`, while it is in flight. */
function findRequest(
  { requests }: Extract<TrackerState, { kind: 'live' }>,
  tap: TapId,
  requestId: string,
): Request | undefined {
  return requests.find(request => request.tap === tap && request.requestId === requestId);
}

/** The request the claim that `settle` ends holds, while it does. */
function findClaim({ requests }: Extract<TrackerState, { kind: 'live' }>, settle: Settle) {
  return requests.find(
    (request): request is Extract<Request, { kind: 'claimed' }> =>
      request.kind === 'claimed' && request.settle === settle,
  );
}

/** Ends `requests`: each network hold is released, and a claimed one settles `gone`. */
function endRequests(requests: readonly Request[], { emitSideEffect }: Transition<TrackerMachine>): void {
  for (const request of requests) {
    emitSideEffect({ kind: 'released', release: request.release });
    if (request.kind === 'claimed') {
      emitSideEffect({ kind: 'settled', settle: request.settle, outcome: { kind: 'gone' } });
    }
  }
}
