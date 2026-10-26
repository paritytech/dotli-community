// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Temporary: the core does not report phone requests to the host, so this infers them from relayed frames. Remove once https://github.com/paritytech/trinity-user-agents/issues/1552 lands.

import type { UserConfirmationReview } from '@parity/truapi-host';
import { PHONE_METHODS, type PhoneMethod } from './phone-methods.js';
import { reportUnmatchablePhoneReview } from './phone-report.js';
import type { PhoneRequest } from './phone-requests.js';

/** Whether `request` is the one a review was shown for. */
export type PhoneReviewMatch = (request: PhoneRequest) => boolean;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** The spelling the core gives product ids before it builds a review. */
function normalizeProductId(id: string): string {
  return id.trim().normalize('NFC').toLowerCase();
}

/** Copies `value` with every `dotNsIdentifier` normalized, since the tracker keeps the product's own spelling. */
function withNormalizedProductIds(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withNormalizedProductIds);
  }
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        key === 'dotNsIdentifier' && typeof inner === 'string'
          ? normalizeProductId(inner)
          : withNormalizedProductIds(inner),
      ]),
    );
  }
  return value;
}

function encodeV1(method: PhoneMethod, value: unknown): Uint8Array {
  return PHONE_METHODS[method].request.enc({ tag: 'V1', value });
}

export type PhoneReviewMatchDeps = {
  /** A review or request that would not encode. */
  reportEncodeFailure?: (method: PhoneMethod, error: unknown) => void;
};

/** Matches a `getAccount` request for an account of `productId`. */
function byAccountOf(productId: string): PhoneReviewMatch {
  return request =>
    request.method === 'getAccount' &&
    normalizeProductId(
      (request.body as { productAccountId: { dotNsIdentifier: string } }).productAccountId.dotNsIdentifier,
    ) === productId;
}

/** How to find the request behind `review`, or undefined for a review that never waits on the phone. */
export function phoneReviewMatch(
  review: UserConfirmationReview,
  { reportEncodeFailure = reportUnmatchablePhoneReview }: PhoneReviewMatchDeps = {},
): PhoneReviewMatch | undefined {
  /**
   * Matches a request of one of `methods` whose V1 encoding equals that of `value`. With `callData`, the request's
   * call data is read as `callData` (the core rewrites it for declared contacts before it builds the review).
   */
  const byRequest = (methods: [PhoneMethod, ...PhoneMethod[]], value: unknown, callData?: string): PhoneReviewMatch => {
    // Encoded at the first request matched, so a review with nothing in flight, as on a local wallet, encodes nothing.
    let encoded: Map<PhoneMethod, Uint8Array> | null | undefined;
    const expectedFor = (method: PhoneMethod): Uint8Array | undefined => {
      if (encoded === undefined) {
        try {
          encoded = new Map(methods.map(each => [each, encodeV1(each, value)]));
        } catch (error) {
          reportEncodeFailure(methods[0], error);
          encoded = null;
        }
      }
      return encoded?.get(method);
    };
    return request => {
      if (!methods.includes(request.method)) {
        return false;
      }
      const expected = expectedFor(request.method);
      if (expected === undefined) {
        return false;
      }
      try {
        let body = withNormalizedProductIds(request.body);
        if (callData !== undefined) {
          body = { ...(body as object), callData };
        }
        return sameBytes(expected, encodeV1(request.method, body));
      } catch (error) {
        reportEncodeFailure(request.method, error);
        return false;
      }
    };
  };
  switch (review.tag) {
    case 'SignPayload':
      return review.value.tag === 'Product'
        ? byRequest(['signPayload'], review.value.value.request)
        : byRequest(['signPayloadWithLegacyAccount'], review.value.value);
    case 'SignRaw':
      return review.value.tag === 'Product'
        ? byRequest(['signRaw', 'signRawUnwatermarkedDeprecated'], review.value.value.request)
        : byRequest(
            ['signRawWithLegacyAccount', 'signRawUnwatermarkedDeprecatedWithLegacyAccount'],
            review.value.value.request,
          );
    case 'CreateTransaction':
      return review.value.tag === 'Product'
        ? byRequest(
            ['createTransaction'],
            review.value.value.payload,
            review.value.value.payload.contacts.length > 0 ? review.value.value.payload.callData : undefined,
          )
        : byRequest(['createTransactionWithLegacyAccount'], review.value.value);
    case 'SignVrf':
      return byRequest(['signVrf'], review.value.request);
    case 'ResourceAllocation':
      return byRequest(['requestResourceAllocation'], { resources: review.value.resources });
    case 'ProductSubtree':
      return byAccountOf(review.value.productId);
    case 'AccountAccess':
      return byAccountOf(review.value.targetProductId);
    case 'AccountAlias':
    case 'CreateProof':
    case 'IdentityDisclosure':
    case 'PreimageSubmit':
    case 'StatementStoreProductSign':
      return undefined;
  }
}
