// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Temporary: the core does not report phone requests to the host, so this infers them from relayed frames. Remove once https://github.com/paritytech/trinity-user-agents/issues/1552 lands.

import {
  VersionedHostAccountGetError,
  VersionedHostAccountGetRequest,
  VersionedHostAccountGetResponse,
  VersionedHostAccountSignVrfError,
  VersionedHostAccountSignVrfRequest,
  VersionedHostAccountSignVrfResponse,
  VersionedHostCreateTransactionError,
  VersionedHostCreateTransactionRequest,
  VersionedHostCreateTransactionResponse,
  VersionedHostCreateTransactionWithLegacyAccountError,
  VersionedHostCreateTransactionWithLegacyAccountRequest,
  VersionedHostCreateTransactionWithLegacyAccountResponse,
  VersionedHostRequestResourceAllocationError,
  VersionedHostRequestResourceAllocationRequest,
  VersionedHostRequestResourceAllocationResponse,
  VersionedHostSignPayloadError,
  VersionedHostSignPayloadRequest,
  VersionedHostSignPayloadResponse,
  VersionedHostSignPayloadWithLegacyAccountError,
  VersionedHostSignPayloadWithLegacyAccountRequest,
  VersionedHostSignPayloadWithLegacyAccountResponse,
  VersionedHostSignRawError,
  VersionedHostSignRawRequest,
  VersionedHostSignRawResponse,
  VersionedHostSignRawWithLegacyAccountError,
  VersionedHostSignRawWithLegacyAccountRequest,
  VersionedHostSignRawWithLegacyAccountResponse,
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
import { CallError, Result, type CallErrorValue, type Codec } from '@parity/truapi/scale';

/** What the phone is asked to do, which words the waiting step. */
export type PhoneAsk = 'sign' | 'approve';

export type PhoneMethod = keyof typeof PHONE_METHODS;

type ResponseCodec = Codec<Result<unknown, CallErrorValue<unknown>>>;

/** One phone-bound method: its wire ids, its codecs and what the phone is asked to do. */
type PhoneMethodEntry = {
  ids: MethodIds;
  /** The method's `Versioned...Request` codec. */
  request: Codec<unknown>;
  /** The method's response, as the generated wire decode table pairs it. */
  response: ResponseCodec;
  ask: PhoneAsk;
};

type Params<Request, Ok, Failure> = {
  ids: MethodIds;
  /** The method's `Versioned...Request` codec. */
  request: Codec<Request>;
  /** The method's `Versioned...Response` codec. */
  ok: Codec<Ok>;
  /** The method's `Versioned...Error` codec. */
  error: Codec<Failure>;
  ask: PhoneAsk;
};

/** Every method whose request goes to the paired phone, by name. */
export const PHONE_METHODS = {
  signPayload: buildMethodEntry({
    ids: SIGNING_SIGN_PAYLOAD,
    request: VersionedHostSignPayloadRequest,
    ok: VersionedHostSignPayloadResponse,
    error: VersionedHostSignPayloadError,
    ask: 'sign',
  }),
  signPayloadWithLegacyAccount: buildMethodEntry({
    ids: SIGNING_SIGN_PAYLOAD_WITH_LEGACY_ACCOUNT,
    request: VersionedHostSignPayloadWithLegacyAccountRequest,
    ok: VersionedHostSignPayloadWithLegacyAccountResponse,
    error: VersionedHostSignPayloadWithLegacyAccountError,
    ask: 'sign',
  }),
  createTransaction: buildMethodEntry({
    ids: SIGNING_CREATE_TRANSACTION,
    request: VersionedHostCreateTransactionRequest,
    ok: VersionedHostCreateTransactionResponse,
    error: VersionedHostCreateTransactionError,
    ask: 'sign',
  }),
  createTransactionWithLegacyAccount: buildMethodEntry({
    ids: SIGNING_CREATE_TRANSACTION_WITH_LEGACY_ACCOUNT,
    request: VersionedHostCreateTransactionWithLegacyAccountRequest,
    ok: VersionedHostCreateTransactionWithLegacyAccountResponse,
    error: VersionedHostCreateTransactionWithLegacyAccountError,
    ask: 'sign',
  }),
  signRaw: buildMethodEntry({
    ids: SIGNING_SIGN_RAW,
    request: VersionedHostSignRawRequest,
    ok: VersionedHostSignRawResponse,
    error: VersionedHostSignRawError,
    ask: 'sign',
  }),
  signRawWithLegacyAccount: buildMethodEntry({
    ids: SIGNING_SIGN_RAW_WITH_LEGACY_ACCOUNT,
    request: VersionedHostSignRawWithLegacyAccountRequest,
    ok: VersionedHostSignRawWithLegacyAccountResponse,
    error: VersionedHostSignRawWithLegacyAccountError,
    ask: 'sign',
  }),
  signRawUnwatermarkedDeprecated: buildMethodEntry({
    ids: SIGNING_SIGN_RAW_UNWATERMARKED_DEPRECATED,
    request: VersionedHostSignRawRequest,
    ok: VersionedHostSignRawResponse,
    error: VersionedHostSignRawError,
    ask: 'sign',
  }),
  signRawUnwatermarkedDeprecatedWithLegacyAccount: buildMethodEntry({
    ids: SIGNING_SIGN_RAW_UNWATERMARKED_DEPRECATED_WITH_LEGACY_ACCOUNT,
    request: VersionedHostSignRawWithLegacyAccountRequest,
    ok: VersionedHostSignRawWithLegacyAccountResponse,
    error: VersionedHostSignRawWithLegacyAccountError,
    ask: 'sign',
  }),
  signVrf: buildMethodEntry({
    ids: ACCOUNT_SIGN_VRF,
    request: VersionedHostAccountSignVrfRequest,
    ok: VersionedHostAccountSignVrfResponse,
    error: VersionedHostAccountSignVrfError,
    ask: 'sign',
  }),
  getAccount: buildMethodEntry({
    ids: ACCOUNT_GET_ACCOUNT,
    request: VersionedHostAccountGetRequest,
    ok: VersionedHostAccountGetResponse,
    error: VersionedHostAccountGetError,
    ask: 'approve',
  }),
  requestResourceAllocation: buildMethodEntry({
    ids: RESOURCE_ALLOCATION_REQUEST,
    request: VersionedHostRequestResourceAllocationRequest,
    ok: VersionedHostRequestResourceAllocationResponse,
    error: VersionedHostRequestResourceAllocationError,
    ask: 'approve',
  }),
} satisfies Record<string, PhoneMethodEntry>;

/**
 * The response codec must be the generated client's exact composition, as a bare codec would decode real response
 * bytes as garbage.
 */
function buildMethodEntry<Request, Ok, Failure>({
  ids,
  request,
  ok,
  error,
  ask,
}: Params<Request, Ok, Failure>): PhoneMethodEntry {
  return {
    ids,
    // Erases the method's request type, so one table holds every method's request codec.
    request: request as Codec<unknown>,
    // Erases the method's ok and error types, so one table holds every method's response codec.
    response: Result(ok, CallError(error)) as unknown as ResponseCodec,
    ask,
  };
}
