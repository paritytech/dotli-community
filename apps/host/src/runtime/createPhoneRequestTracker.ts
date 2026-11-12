// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Temporary: the core does not report phone requests to the host, so this infers them from relayed frames. Remove once https://github.com/paritytech/trinity-user-agents/issues/1552 lands.

import { createReporter, defineCount } from '@dotli/metrics';
import { createDeferred, createStateMachine, getKeys, isRecord, nest, type MachineTypes } from '@dotli/shared';
import { decodeWireMessage, MESSAGE_TYPE_REQUEST, MESSAGE_TYPE_RESPONSE } from '@parity/truapi';
import { compact } from '@parity/truapi/scale';
import { networkPause, type NetworkPause } from './createNetworkPause.js';
import { PHONE_METHODS, type PhoneMethod } from './phoneMethods.js';
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

type FrameHeader = {
  requestId: string;
  /** Undefined for a method that does not go to the phone. */
  method: PhoneMethod | undefined;
  messageType: number;
};

/** One connection's tap, told apart by identity. */
type TapId = symbol;

type TrackerState = { kind: 'live'; taps: ReadonlyMap<TapId, Tap> } | { kind: 'disposed' };

/** A tap leaves the map when it closes, so `taps` holds the open ones. */
type Tap = { kind: 'open'; inflight: ReadonlyMap<string, Request> } | { kind: 'closed' };

/** A request leaves its tap's map when it ends. */
type Request =
  | {
      kind: 'tracked';
      /** The order the request was tracked in, so the oldest is claimed first. */
      sequence: number;
      request: PhoneRequest;
      /** Releases this request's network hold. Acts once. */
      release: () => void;
    }
  | {
      kind: 'claimed';
      sequence: number;
      request: PhoneRequest;
      release: () => void;
      settle: (outcome: PhoneOutcome) => void;
    }
  | { kind: 'ended' };

type TrackerEvent =
  | { kind: 'tapOpened'; tap: TapId }
  | { kind: 'requested'; tap: TapId; requestId: string; method: PhoneMethod; sequence: number; message: Uint8Array }
  | { kind: 'answered'; tap: TapId; requestId: string; method: FrameHeader['method']; message: Uint8Array }
  | { kind: 'claimed'; tap: TapId; requestId: string; settle: (outcome: PhoneOutcome) => void }
  // The claimer gave up on its claim made inside a transition, which has no holder to settle it.
  | { kind: 'claimDropped'; tap: TapId; requestId: string; settle: (outcome: PhoneOutcome) => void }
  | { kind: 'tapClosed'; tap: TapId }
  | { kind: 'disposed' };

type TrackerEffect = { kind: 'undecodable'; method: PhoneMethod; error: unknown; leg: PhoneLeg };

type TrackerMachine = MachineTypes<TrackerState, TrackerEvent, TrackerEffect>;

type TapMachine = MachineTypes<Tap, TrackerEvent, TrackerEffect>;

type RequestMachine = MachineTypes<Request, TrackerEvent, TrackerEffect>;

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
  holdNetwork = networkPause.hold,
}: Params = {}) {
  const handleRequest = nest<TapMachine, 'open', RequestMachine, 'answered' | 'claimed' | 'claimDropped'>({
    find: ({ inflight }, { requestId }) => inflight.get(requestId) ?? null,
    store(state, { requestId }, next) {
      const inflight = new Map(state.inflight);
      switch (next.kind) {
        case 'tracked':
        case 'claimed':
          inflight.set(requestId, next);
          break;
        case 'ended':
          inflight.delete(requestId);
          break;
      }
      return { ...state, inflight };
    },
    handlers: {
      tracked: {
        answered({ request, release }, { method }, { emitState }) {
          if (method !== request.method) {
            return;
          }
          emitState({ kind: 'ended' });
          release();
        },
        claimed(state, { settle }, { emitState }) {
          emitState({ ...state, kind: 'claimed', settle });
        },
      },
      claimed: {
        answered({ request, release, settle }, { method, message }, { emitState, emitSideEffect }) {
          if (method !== request.method) {
            return;
          }
          emitState({ kind: 'ended' });
          release();
          try {
            settle(decodePhoneOutcome(request.method, readPayload(message)));
          } catch (error) {
            emitSideEffect({ kind: 'undecodable', method: request.method, error, leg: 'response' });
            settle({ kind: 'undecodable' });
          }
        },
        claimDropped({ sequence, request, release, settle }, event, { emitState }) {
          if (event.settle !== settle) {
            return;
          }
          emitState({ kind: 'tracked', sequence, request, release });
        },
      },
      ended: null,
    },
  });
  const handleTap = nest<
    TrackerMachine,
    'live',
    TapMachine,
    'requested' | 'answered' | 'claimed' | 'claimDropped' | 'tapClosed'
  >({
    find: ({ taps }, { tap }) => taps.get(tap) ?? null,
    store(state, { tap }, next) {
      const taps = new Map(state.taps);
      switch (next.kind) {
        case 'open':
          taps.set(tap, next);
          break;
        case 'closed':
          taps.delete(tap);
          break;
      }
      return { ...state, taps };
    },
    handlers: {
      open: {
        requested(state, { requestId, method, sequence, message }, { emitState, emitSideEffect }) {
          if (state.inflight.has(requestId)) {
            return;
          }
          try {
            const body = unwrapV1(PHONE_METHODS[method].request.dec(readPayload(message)));
            const release = holdNetwork();
            emitState({
              ...state,
              inflight: new Map(state.inflight).set(requestId, {
                kind: 'tracked',
                sequence,
                request: { method, body },
                release,
              }),
            });
          } catch (error) {
            emitSideEffect({ kind: 'undecodable', method, error, leg: 'request' });
          }
        },
        answered: handleRequest,
        claimed: handleRequest,
        claimDropped: handleRequest,
        tapClosed(state, _event, { emitState }) {
          emitState({ kind: 'closed' });
          endRequests(state);
        },
      },
      closed: null,
    },
  });
  const machine = createStateMachine<TrackerMachine>({
    initial: { kind: 'live', taps: new Map() },
    handlers: {
      live: {
        tapOpened(state, { tap }, { emitState }) {
          emitState({ ...state, taps: new Map(state.taps).set(tap, { kind: 'open', inflight: new Map() }) });
        },
        requested: handleTap,
        answered: handleTap,
        claimed: handleTap,
        claimDropped: handleTap,
        tapClosed: handleTap,
        disposed({ taps }, _event, { emitState }) {
          emitState({ kind: 'disposed' });
          for (const tap of taps.values()) {
            endRequests(tap);
          }
        },
      },
      disposed: null,
    },
    onEffect({ method, error, leg }) {
      reportUndecodable({ method, error, leg });
    },
    onError: error => {
      report.defect(error, {
        step: 'phone_tracker_transition',
        metric: phoneTrackerTransitionMetric,
        message: '[dot.li phone request] A transition of the tracker threw:',
      });
    },
  });
  let sequence = 0;

  /** The payload of a frame whose header was already peeked, so only a frame it cannot read fails. */
  function readPayload(message: Uint8Array): Uint8Array {
    const decoded = decode(message);
    if (decoded.isErr()) {
      throw decoded.error;
    }
    return decoded.value.payload.value;
  }

  function connect() {
    const tap: TapId = Symbol('phone request tap');
    machine.update({ kind: 'tapOpened', tap });

    function fromProduct(message: Uint8Array): void {
      const header = peekHeader(message);
      if (header?.method === undefined || header.messageType !== MESSAGE_TYPE_REQUEST) {
        return;
      }
      machine.update({
        kind: 'requested',
        tap,
        requestId: header.requestId,
        method: header.method,
        sequence: sequence++,
        message,
      });
    }

    function fromCore(message: Uint8Array): void {
      // Most frames answer no tracked request, so a tap that holds none skips the peek.
      if (getInflight(machine.state.get(), tap).size === 0) {
        return;
      }
      const header = peekHeader(message);
      if (header?.messageType !== MESSAGE_TYPE_RESPONSE) {
        return;
      }
      machine.update({ kind: 'answered', tap, requestId: header.requestId, method: header.method, message });
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
    const oldest = listUnclaimed(machine.state.get())
      .sort((a, b) => a.sequence - b.sequence)
      .find(({ request }) => matches(request));
    if (oldest === undefined) {
      return undefined;
    }
    const { tap, requestId } = oldest;
    const { promise, resolve: settle } = createDeferred<PhoneOutcome>();
    machine.update({ kind: 'claimed', tap, requestId, settle });
    // A claim made inside a tracker transition has its event run after this returns, so it holds nothing yet. It
    // returns no claim, and drops it in an event that runs right after the claim's, so the request stays claimable.
    const held = getInflight(machine.state.get(), tap).get(requestId);
    if (held?.kind !== 'claimed' || held.settle !== settle) {
      machine.update({ kind: 'claimDropped', tap, requestId, settle });
      return undefined;
    }
    return { request: held.request, ended: promise };
  }

  function dispose(): void {
    machine.update({ kind: 'disposed' });
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

/** Ends each request `tap` holds: its network hold is released, and a claimed one settles `gone`. */
function endRequests(tap: Tap): void {
  if (tap.kind === 'closed') {
    return;
  }
  for (const request of tap.inflight.values()) {
    switch (request.kind) {
      case 'tracked':
        request.release();
        break;
      case 'claimed':
        request.release();
        request.settle({ kind: 'gone' });
        break;
      case 'ended':
        break;
    }
  }
}

/** The requests `tap` holds, none once it closed or the tracker was disposed. */
function getInflight(state: TrackerState, tap: TapId): ReadonlyMap<string, Request> {
  const held = state.kind === 'live' ? state.taps.get(tap) : undefined;
  return held?.kind === 'open' ? held.inflight : new Map<string, Request>();
}

/** The tracked requests no claim holds yet, across the open taps. */
function listUnclaimed(state: TrackerState) {
  const unclaimed: { tap: TapId; requestId: string; sequence: number; request: PhoneRequest }[] = [];
  if (state.kind === 'disposed') {
    return unclaimed;
  }
  for (const [tap, held] of state.taps) {
    if (held.kind === 'closed') {
      continue;
    }
    for (const [requestId, request] of held.inflight) {
      if (request.kind === 'tracked') {
        unclaimed.push({ tap, requestId, sequence: request.sequence, request: request.request });
      }
    }
  }
  return unclaimed;
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
