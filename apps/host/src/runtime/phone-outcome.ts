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
import type { PhoneMethod } from './phone-requests.js';

export type PhoneOutcome =
  | { kind: 'ok'; method: PhoneMethod; allocations?: readonly AllocationOutcome[] }
  | { kind: 'rejected' }
  | { kind: 'withdrawn' }
  | { kind: 'failed'; reason: string }
  | { kind: 'gone' };

/** Must be the generated client's exact composition, as a bare codec would decode real response bytes as garbage. */
function responseOf<T, E>(ok: Codec<T>, err: Codec<E>): Codec<Result<T, CallErrorValue<E>>> {
  return Result(ok, CallError(err));
}

const SIGN_RAW = responseOf(VersionedHostSignRawResponse, VersionedHostSignRawError);
const SIGN_RAW_LEGACY = responseOf(
  VersionedHostSignRawWithLegacyAccountResponse,
  VersionedHostSignRawWithLegacyAccountError,
);

/** The response codec of each method, as the generated wire decode table pairs them. */
export const PHONE_RESPONSE_CODECS: Record<PhoneMethod, Codec<Result<unknown, CallErrorValue<unknown>>>> = {
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
} as Record<PhoneMethod, Codec<Result<unknown, CallErrorValue<unknown>>>>;

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
          : { kind: 'failed', reason: reasonOf(inner.value) ?? inner.tag };
      }
      return { kind: 'failed', reason: error.tag };
    }
    case 'MalformedFrame':
    case 'HostFailure':
      return { kind: 'failed', reason: reasonOf(error.value) ?? error.tag };
    case 'Denied':
    case 'Unsupported':
      return { kind: 'failed', reason: error.tag };
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
