// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Temporary: the core does not report phone requests to the host, so this infers them from relayed frames. Remove once https://github.com/paritytech/trinity-user-agents/issues/1552 lands.

import {
  VersionedHostAccountGetError,
  VersionedHostAccountGetResponse,
  VersionedHostAccountSignVrfError,
  VersionedHostAccountSignVrfResponse,
  VersionedHostCreateTransactionError,
  VersionedHostCreateTransactionResponse,
  VersionedHostCreateTransactionWithLegacyAccountError,
  VersionedHostCreateTransactionWithLegacyAccountResponse,
  VersionedHostRequestResourceAllocationError,
  VersionedHostRequestResourceAllocationResponse,
  VersionedHostSignPayloadError,
  VersionedHostSignPayloadResponse,
  VersionedHostSignPayloadWithLegacyAccountError,
  VersionedHostSignPayloadWithLegacyAccountResponse,
  VersionedHostSignRawError,
  VersionedHostSignRawResponse,
  VersionedHostSignRawWithLegacyAccountError,
  VersionedHostSignRawWithLegacyAccountResponse,
  type AllocationOutcome,
} from '@parity/truapi';
import { CallError, Result, type CallErrorValue, type Codec } from '@parity/truapi/scale';
import type { MetricOutcome } from '@dotli/metrics';
import type { PhoneMethod } from './phone-requests.js';

export type PhoneOutcome =
  | { kind: 'ok'; method: PhoneMethod; allocations?: readonly AllocationOutcome[] }
  | { kind: 'rejected' }
  | { kind: 'withdrawn' }
  /** `tag` is the bounded error tag a metric may count, `reason` the free text a toast may show. */
  | { kind: 'failed'; tag: string; reason: string }
  | { kind: 'gone' };

type ResponseCodec = Codec<Result<unknown, CallErrorValue<unknown>>>;

/**
 * Must be the generated client's exact composition, as a bare codec would decode real response bytes as garbage.
 * The widening cast is the one place the method-specific types are erased.
 */
function responseOf<T, E>(ok: Codec<T>, err: Codec<E>): ResponseCodec {
  return Result(ok, CallError(err)) as unknown as ResponseCodec;
}

const SIGN_RAW = responseOf(VersionedHostSignRawResponse, VersionedHostSignRawError);
const SIGN_RAW_LEGACY = responseOf(
  VersionedHostSignRawWithLegacyAccountResponse,
  VersionedHostSignRawWithLegacyAccountError,
);

/** The response codec of each method, as the generated wire decode table pairs them. */
export const PHONE_RESPONSE_CODECS: Record<PhoneMethod, ResponseCodec> = {
  signPayload: responseOf(VersionedHostSignPayloadResponse, VersionedHostSignPayloadError),
  signPayloadWithLegacyAccount: responseOf(
    VersionedHostSignPayloadWithLegacyAccountResponse,
    VersionedHostSignPayloadWithLegacyAccountError,
  ),
  createTransaction: responseOf(VersionedHostCreateTransactionResponse, VersionedHostCreateTransactionError),
  createTransactionWithLegacyAccount: responseOf(
    VersionedHostCreateTransactionWithLegacyAccountResponse,
    VersionedHostCreateTransactionWithLegacyAccountError,
  ),
  signRaw: SIGN_RAW,
  signRawWithLegacyAccount: SIGN_RAW_LEGACY,
  signRawUnwatermarkedDeprecated: SIGN_RAW,
  signRawUnwatermarkedDeprecatedWithLegacyAccount: SIGN_RAW_LEGACY,
  signVrf: responseOf(VersionedHostAccountSignVrfResponse, VersionedHostAccountSignVrfError),
  getAccount: responseOf(VersionedHostAccountGetResponse, VersionedHostAccountGetError),
  requestResourceAllocation: responseOf(
    VersionedHostRequestResourceAllocationResponse,
    VersionedHostRequestResourceAllocationError,
  ),
};

interface Tagged {
  tag: string;
  value?: unknown;
}

function isTagged(value: unknown): value is Tagged {
  return typeof value === 'object' && value !== null && typeof (value as Tagged).tag === 'string';
}

function reasonOf(value: unknown): string | undefined {
  const reason = (value as { reason?: unknown } | null | undefined)?.reason;
  return typeof reason === 'string' ? reason : undefined;
}

function failureOf(error: CallErrorValue<unknown>): PhoneOutcome {
  switch (error.tag) {
    case 'Cancelled':
      return { kind: 'withdrawn' };
    case 'Domain': {
      // A domain error is a versioned envelope around the method's own error enum.
      const inner = isTagged(error.value) ? error.value.value : undefined;
      if (isTagged(inner)) {
        return inner.tag === 'Rejected'
          ? { kind: 'rejected' }
          : { kind: 'failed', tag: inner.tag, reason: reasonOf(inner.value) ?? inner.tag };
      }
      return { kind: 'failed', tag: error.tag, reason: error.tag };
    }
    case 'MalformedFrame':
    case 'HostFailure':
      return { kind: 'failed', tag: error.tag, reason: reasonOf(error.value) ?? error.tag };
    case 'Denied':
    case 'Unsupported':
      return { kind: 'failed', tag: error.tag, reason: error.tag };
  }
}

function allocationsOf(method: PhoneMethod, value: unknown): readonly AllocationOutcome[] | undefined {
  if (method !== 'requestResourceAllocation') {
    return undefined;
  }
  const outcomes = (isTagged(value) ? (value.value as { outcomes?: unknown } | undefined) : undefined)?.outcomes;
  return Array.isArray(outcomes) ? (outcomes as AllocationOutcome[]) : undefined;
}

/**
 * How a response frame's payload ended `method`'s call.
 * Throws when the payload does not decode, which the caller reports.
 */
export function decodePhoneOutcome(method: PhoneMethod, payload: Uint8Array): PhoneOutcome {
  const result = PHONE_RESPONSE_CODECS[method].dec(payload);
  if (!result.success) {
    return failureOf(result.value);
  }
  const allocations = allocationsOf(method, result.value);
  return allocations === undefined ? { kind: 'ok', method } : { kind: 'ok', method, allocations };
}

/** The shared metric vocabulary's word for how a request ended. */
export function phoneMetricOutcome(kind: PhoneOutcome['kind']): MetricOutcome {
  switch (kind) {
    case 'ok':
      return 'ok';
    case 'rejected':
      return 'refused';
    case 'withdrawn':
      return 'aborted';
    case 'failed':
      return 'error';
    case 'gone':
      return 'gone';
  }
}
