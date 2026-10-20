// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Temporary: the core does not report phone requests to the host, so this infers them from relayed frames. Remove once https://github.com/paritytech/trinity-user-agents/issues/1552 lands.

import {
  decodeWireMessage,
  MESSAGE_TYPE_REQUEST,
  MESSAGE_TYPE_RESPONSE,
  VersionedHostAccountGetRequest,
  VersionedHostAccountSignVrfRequest,
  VersionedHostCreateTransactionRequest,
  VersionedHostCreateTransactionWithLegacyAccountRequest,
  VersionedHostRequestResourceAllocationRequest,
  VersionedHostSignPayloadRequest,
  VersionedHostSignPayloadWithLegacyAccountRequest,
  VersionedHostSignRawRequest,
  VersionedHostSignRawWithLegacyAccountRequest,
  type MethodIds,
} from '@parity/truapi';
import {
  ACCOUNT_GET_ACCOUNT,
  ACCOUNT_SIGN_VRF,
  RESOURCE_ALLOCATION_REQUEST,
  SIGNING_CREATE_TRANSACTION,
  SIGNING_CREATE_TRANSACTION_WITH_LEGACY_ACCOUNT,
  SIGNING_SIGN_PAYLOAD,
  SIGNING_SIGN_PAYLOAD_WITH_LEGACY_ACCOUNT,
  SIGNING_SIGN_RAW,
  SIGNING_SIGN_RAW_UNWATERMARKED_DEPRECATED,
  SIGNING_SIGN_RAW_UNWATERMARKED_DEPRECATED_WITH_LEGACY_ACCOUNT,
  SIGNING_SIGN_RAW_WITH_LEGACY_ACCOUNT,
} from '@parity/truapi/wire-table';
import type { Codec } from '@parity/truapi/scale';
import { captureException, m, spans as S } from '@dotli/metrics';
import { log } from '@dotli/shared';
import { decodePhoneOutcome, UNDECODABLE_TAG, type PhoneOutcome } from './phone-outcome.js';

export type PhoneMethod =
  | 'signPayload'
  | 'signPayloadWithLegacyAccount'
  | 'createTransaction'
  | 'createTransactionWithLegacyAccount'
  | 'signRaw'
  | 'signRawWithLegacyAccount'
  | 'signRawUnwatermarkedDeprecated'
  | 'signRawUnwatermarkedDeprecatedWithLegacyAccount'
  | 'signVrf'
  | 'getAccount'
  | 'requestResourceAllocation';

/** A phone-bound request in flight, with its V1 request body as `@parity/truapi` decodes it. */
export interface PhoneRequest {
  method: PhoneMethod;
  /** The unwrapped V1 value of the method's `Versioned...Request` codec. */
  body: unknown;
  /** The request as the `Versioned...Request` codec encodes it with the V1 tag, for exact comparison. */
  bytes: Uint8Array;
}

export interface PhoneClaim {
  request: PhoneRequest;
  /** Settles once with how the request ended. Never rejects. */
  ended: Promise<PhoneOutcome>;
}

export interface PhoneRequestTap {
  /** Each frame the product sent to the core. */
  fromProduct: (message: Uint8Array) => void;
  /** Each frame the core sent to the product, after it was forwarded. */
  fromCore: (message: Uint8Array) => void;
  /** Ends this connection's claims as `gone`. Idempotent. */
  close: () => void;
}

export interface PhoneRequestTracker {
  connect: () => PhoneRequestTap;
  /** The oldest unclaimed in-flight request that `matches`, now claimed, or undefined. */
  claim: (matches: (request: PhoneRequest) => boolean) => PhoneClaim | undefined;
  /** Ends every claim as `gone`. Idempotent. */
  dispose: () => void;
}

/** Which way a frame was going. */
export type PhoneLeg = 'request' | 'response';

export interface PhoneRequestTrackerDeps {
  /**
   * A tracked frame that would not decode. Default: `captureException` and `log.error`, and the `undecodable` count for
   * a request. A response ends its claim, and the claim's end is counted.
   */
  reportUndecodable?: (method: PhoneMethod, error: unknown, leg: PhoneLeg) => void;
}

interface RequestEntry {
  ids: MethodIds;
  request: Codec<unknown>;
}

/** Erases the method-specific request type, the one place the table's codecs are widened. */
function entryOf<T>(ids: MethodIds, request: Codec<T>): RequestEntry {
  return { ids, request: request as Codec<unknown> };
}

/** The wire id and request codec of each method, exported for the frame builders of specs. */
export const PHONE_REQUEST_CODECS: Record<PhoneMethod, RequestEntry> = {
  signPayload: entryOf(SIGNING_SIGN_PAYLOAD, VersionedHostSignPayloadRequest),
  signPayloadWithLegacyAccount: entryOf(
    SIGNING_SIGN_PAYLOAD_WITH_LEGACY_ACCOUNT,
    VersionedHostSignPayloadWithLegacyAccountRequest,
  ),
  createTransaction: entryOf(SIGNING_CREATE_TRANSACTION, VersionedHostCreateTransactionRequest),
  createTransactionWithLegacyAccount: entryOf(
    SIGNING_CREATE_TRANSACTION_WITH_LEGACY_ACCOUNT,
    VersionedHostCreateTransactionWithLegacyAccountRequest,
  ),
  signRaw: entryOf(SIGNING_SIGN_RAW, VersionedHostSignRawRequest),
  signRawWithLegacyAccount: entryOf(SIGNING_SIGN_RAW_WITH_LEGACY_ACCOUNT, VersionedHostSignRawWithLegacyAccountRequest),
  signRawUnwatermarkedDeprecated: entryOf(SIGNING_SIGN_RAW_UNWATERMARKED_DEPRECATED, VersionedHostSignRawRequest),
  signRawUnwatermarkedDeprecatedWithLegacyAccount: entryOf(
    SIGNING_SIGN_RAW_UNWATERMARKED_DEPRECATED_WITH_LEGACY_ACCOUNT,
    VersionedHostSignRawWithLegacyAccountRequest,
  ),
  signVrf: entryOf(ACCOUNT_SIGN_VRF, VersionedHostAccountSignVrfRequest),
  getAccount: entryOf(ACCOUNT_GET_ACCOUNT, VersionedHostAccountGetRequest),
  requestResourceAllocation: entryOf(RESOURCE_ALLOCATION_REQUEST, VersionedHostRequestResourceAllocationRequest),
};

const METHOD_BY_ADDRESS = new Map<number, PhoneMethod>(
  (Object.entries(PHONE_REQUEST_CODECS) as [PhoneMethod, { ids: MethodIds }][]).map(([method, { ids }]) => [
    (ids.trait << 8) | ids.method,
    method,
  ]),
);

function methodAt(traitId: number, methodId: number): PhoneMethod | undefined {
  return METHOD_BY_ADDRESS.get((traitId << 8) | methodId);
}

function reportUndecodableDefault(method: PhoneMethod, error: unknown, leg: PhoneLeg): void {
  captureException(error, { flow: 'wallet', step: 'phone_request', tags: { method } });
  log.error(`[dot.li phone request] ${method} ${leg} did not decode:`, error);
  if (leg === 'request') {
    m.count(S.PHONE_REQUEST, { outcome: 'undecodable', reason: method });
  }
}

interface Tracked {
  seq: number;
  request: PhoneRequest;
  /** Set once claimed, and settles the claim. */
  settle: ((outcome: PhoneOutcome) => void) | undefined;
}

export function createPhoneRequestTracker({
  reportUndecodable = reportUndecodableDefault,
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
          const decoded = decodeWireMessage(message);
          if (decoded.isErr()) {
            // The tap is passive, so the core reports a malformed frame itself.
            return;
          }
          const { requestId, payload } = decoded.value;
          const method = methodAt(payload.traitId, payload.methodId);
          if (method === undefined || payload.messageType !== MESSAGE_TYPE_REQUEST || inflight.has(requestId)) {
            return;
          }
          try {
            const codec = PHONE_REQUEST_CODECS[method].request;
            const versioned = codec.dec(payload.value) as { tag: string; value: unknown };
            if (versioned.tag !== 'V1') {
              throw new Error(`unsupported request version ${versioned.tag}`);
            }
            inflight.set(requestId, {
              seq: seq++,
              request: { method, body: versioned.value, bytes: codec.enc(versioned) },
              settle: undefined,
            });
          } catch (error) {
            reportUndecodable(method, error, 'request');
          }
        },
        fromCore(message) {
          // A closed tap has already ended its claims and emptied its map, so this covers it too.
          if (inflight.size === 0) {
            return;
          }
          const decoded = decodeWireMessage(message);
          if (decoded.isErr()) {
            // The tap is passive, so the core reports a malformed frame itself.
            return;
          }
          const { requestId, payload } = decoded.value;
          const tracked = inflight.get(requestId);
          if (
            tracked === undefined ||
            payload.messageType !== MESSAGE_TYPE_RESPONSE ||
            methodAt(payload.traitId, payload.methodId) !== tracked.request.method
          ) {
            return;
          }
          inflight.delete(requestId);
          if (tracked.settle === undefined) {
            return;
          }
          try {
            tracked.settle(decodePhoneOutcome(tracked.request.method, payload.value));
          } catch (error) {
            reportUndecodable(tracked.request.method, error, 'response');
            tracked.settle({ kind: 'failed', tag: UNDECODABLE_TAG, reason: UNDECODABLE_TAG });
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
