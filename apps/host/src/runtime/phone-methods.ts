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

/**
 * The response codec must be the generated client's exact composition, as a bare codec would decode real response
 * bytes as garbage. The widening casts are the one place the method-specific types are erased.
 */
function entryOf<Req, Ok, Err>(
  ids: MethodIds,
  request: Codec<Req>,
  ok: Codec<Ok>,
  err: Codec<Err>,
  ask: PhoneAsk,
): PhoneMethodEntry {
  return {
    ids,
    request: request as Codec<unknown>,
    response: Result(ok, CallError(err)) as unknown as ResponseCodec,
    ask,
  };
}

/** Every method whose request goes to the paired phone, exported for the frame builders of specs. */
export const PHONE_METHODS = {
  signPayload: entryOf(
    SIGNING_SIGN_PAYLOAD,
    VersionedHostSignPayloadRequest,
    VersionedHostSignPayloadResponse,
    VersionedHostSignPayloadError,
    'sign',
  ),
  signPayloadWithLegacyAccount: entryOf(
    SIGNING_SIGN_PAYLOAD_WITH_LEGACY_ACCOUNT,
    VersionedHostSignPayloadWithLegacyAccountRequest,
    VersionedHostSignPayloadWithLegacyAccountResponse,
    VersionedHostSignPayloadWithLegacyAccountError,
    'sign',
  ),
  createTransaction: entryOf(
    SIGNING_CREATE_TRANSACTION,
    VersionedHostCreateTransactionRequest,
    VersionedHostCreateTransactionResponse,
    VersionedHostCreateTransactionError,
    'sign',
  ),
  createTransactionWithLegacyAccount: entryOf(
    SIGNING_CREATE_TRANSACTION_WITH_LEGACY_ACCOUNT,
    VersionedHostCreateTransactionWithLegacyAccountRequest,
    VersionedHostCreateTransactionWithLegacyAccountResponse,
    VersionedHostCreateTransactionWithLegacyAccountError,
    'sign',
  ),
  signRaw: entryOf(
    SIGNING_SIGN_RAW,
    VersionedHostSignRawRequest,
    VersionedHostSignRawResponse,
    VersionedHostSignRawError,
    'sign',
  ),
  signRawWithLegacyAccount: entryOf(
    SIGNING_SIGN_RAW_WITH_LEGACY_ACCOUNT,
    VersionedHostSignRawWithLegacyAccountRequest,
    VersionedHostSignRawWithLegacyAccountResponse,
    VersionedHostSignRawWithLegacyAccountError,
    'sign',
  ),
  signRawUnwatermarkedDeprecated: entryOf(
    SIGNING_SIGN_RAW_UNWATERMARKED_DEPRECATED,
    VersionedHostSignRawRequest,
    VersionedHostSignRawResponse,
    VersionedHostSignRawError,
    'sign',
  ),
  signRawUnwatermarkedDeprecatedWithLegacyAccount: entryOf(
    SIGNING_SIGN_RAW_UNWATERMARKED_DEPRECATED_WITH_LEGACY_ACCOUNT,
    VersionedHostSignRawWithLegacyAccountRequest,
    VersionedHostSignRawWithLegacyAccountResponse,
    VersionedHostSignRawWithLegacyAccountError,
    'sign',
  ),
  signVrf: entryOf(
    ACCOUNT_SIGN_VRF,
    VersionedHostAccountSignVrfRequest,
    VersionedHostAccountSignVrfResponse,
    VersionedHostAccountSignVrfError,
    'sign',
  ),
  getAccount: entryOf(
    ACCOUNT_GET_ACCOUNT,
    VersionedHostAccountGetRequest,
    VersionedHostAccountGetResponse,
    VersionedHostAccountGetError,
    'approve',
  ),
  requestResourceAllocation: entryOf(
    RESOURCE_ALLOCATION_REQUEST,
    VersionedHostRequestResourceAllocationRequest,
    VersionedHostRequestResourceAllocationResponse,
    VersionedHostRequestResourceAllocationError,
    'approve',
  ),
} satisfies Record<string, PhoneMethodEntry>;

export type PhoneMethod = keyof typeof PHONE_METHODS;
