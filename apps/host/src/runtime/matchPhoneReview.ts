// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Temporary: the core does not report phone requests to the host, so this infers them from relayed frames. Remove once https://github.com/paritytech/trinity-user-agents/issues/1552 lands.

import { isRecord } from '@dotli/shared';
import type {
  CreateTransactionReview,
  SignPayloadReview,
  SignRawReview,
  UserConfirmationReview,
} from '@parity/truapi-host';
import { PHONE_METHODS, type PhoneMethod } from './phoneMethods.js';
import { reportUnmatchablePhoneReview } from './phoneReport.js';
import type { PhoneRequest } from './createPhoneRequestTracker.js';

/** Whether `request` is the one a review was shown for. */
export type PhoneReviewMatch = (request: PhoneRequest) => boolean;

type Params = {
  /** Reports a review or request that would not encode. Must not throw. */
  reportEncodeFailure?: (method: PhoneMethod, error: unknown) => void;
};

type MatchByRequestParams = {
  /** The call data the request is read with, in place of its own. */
  callData?: string | undefined;
};

/**
 * How to find the request behind `review`, or undefined for a review that never waits on the phone. Never throws: the
 * match it returns reports a review or request that would not encode and answers false for it.
 */
export function matchPhoneReview(
  review: UserConfirmationReview,
  { reportEncodeFailure = reportUnmatchablePhoneReview }: Params = {},
): PhoneReviewMatch | undefined {
  /**
   * Matches a request of one of `methods` whose V1 encoding equals that of `value`. With `callData`, the request's
   * call data is read as `callData` (the core rewrites it for declared contacts before it builds the review).
   */
  function matchByRequest(
    methods: [PhoneMethod, ...PhoneMethod[]],
    value: unknown,
    { callData }: MatchByRequestParams = {},
  ): PhoneReviewMatch {
    // Encoded at the first request matched, so a review with nothing in flight, as on a local wallet, encodes nothing.
    let encoded: Map<PhoneMethod, Uint8Array> | null | undefined;

    function getExpected(method: PhoneMethod): Uint8Array | undefined {
      if (encoded === undefined) {
        try {
          encoded = new Map(methods.map(each => [each, encodeV1(each, value)]));
        } catch (error) {
          reportEncodeFailure(methods[0], error);
          encoded = null;
        }
      }
      return encoded?.get(method);
    }

    function isMatchingRequest(request: PhoneRequest): boolean {
      if (!methods.includes(request.method)) {
        return false;
      }
      const expected = getExpected(request.method);
      if (expected === undefined) {
        return false;
      }
      try {
        const body = normalizeProductIds(request.body);
        const comparedBody = callData !== undefined && isRecord(body) ? { ...body, callData } : body;
        return hasSameBytes(expected, encodeV1(request.method, comparedBody));
      } catch (error) {
        reportEncodeFailure(request.method, error);
        return false;
      }
    }

    return isMatchingRequest;
  }

  function matchSignPayload(signPayload: SignPayloadReview): PhoneReviewMatch {
    switch (signPayload.tag) {
      case 'Product':
        return matchByRequest(['signPayload'], signPayload.value.request);
      case 'LegacyAccount':
        return matchByRequest(['signPayloadWithLegacyAccount'], signPayload.value);
    }
  }

  function matchSignRaw(signRaw: SignRawReview): PhoneReviewMatch {
    switch (signRaw.tag) {
      case 'Product':
        return matchByRequest(['signRaw', 'signRawUnwatermarkedDeprecated'], signRaw.value.request);
      case 'LegacyAccount':
        return matchByRequest(
          ['signRawWithLegacyAccount', 'signRawUnwatermarkedDeprecatedWithLegacyAccount'],
          signRaw.value.request,
        );
    }
  }

  function matchCreateTransaction(transaction: CreateTransactionReview): PhoneReviewMatch {
    switch (transaction.tag) {
      case 'Product': {
        const { payload } = transaction.value;
        return matchByRequest(['createTransaction'], payload, {
          callData: payload.contacts.length > 0 ? payload.callData : undefined,
        });
      }
      case 'LegacyAccount':
        return matchByRequest(['createTransactionWithLegacyAccount'], transaction.value);
    }
  }

  switch (review.tag) {
    case 'SignPayload':
      return matchSignPayload(review.value);
    case 'SignRaw':
      return matchSignRaw(review.value);
    case 'CreateTransaction':
      return matchCreateTransaction(review.value);
    case 'SignVrf':
      return matchByRequest(['signVrf'], review.value.request);
    case 'ResourceAllocation':
      return matchByRequest(['requestResourceAllocation'], { resources: review.value.resources });
    case 'ProductSubtree':
      return matchByAccount(review.value.productId);
    case 'AccountAccess':
      return matchByAccount(review.value.targetProductId);
    case 'AccountAlias':
    case 'CreateProof':
    case 'IdentityDisclosure':
    case 'PreimageSubmit':
    case 'StatementStoreProductSign':
      return undefined;
  }
}

/** Matches a `getAccount` request for an account of `productId`, and answers false for a body that names none. */
function matchByAccount(productId: string): PhoneReviewMatch {
  return request => request.method === 'getAccount' && getAccountProductId(request.body) === productId;
}

/** The normalized product id a `getAccount` request's body names, or undefined when it names none. */
function getAccountProductId(body: unknown): string | undefined {
  const account = isRecord(body) ? body['productAccountId'] : undefined;
  const id = isRecord(account) ? account['dotNsIdentifier'] : undefined;
  return typeof id === 'string' ? normalizeProductId(id) : undefined;
}

function hasSameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** The spelling the core gives product ids before it builds a review. */
function normalizeProductId(id: string): string {
  return id.trim().normalize('NFC').toLowerCase();
}

/** Copies `value` with every `dotNsIdentifier` normalized, since the tracker keeps the product's own spelling. */
function normalizeProductIds(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeProductIds);
  }
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        key === 'dotNsIdentifier' && typeof inner === 'string' ? normalizeProductId(inner) : normalizeProductIds(inner),
      ]),
    );
  }
  return value;
}

function encodeV1(method: PhoneMethod, value: unknown): Uint8Array {
  return PHONE_METHODS[method].request.enc({ tag: 'V1', value });
}
