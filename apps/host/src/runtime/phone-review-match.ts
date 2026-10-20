// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Temporary: the core does not report phone requests to the host, so this infers them from relayed frames. Remove once https://github.com/paritytech/trinity-user-agents/issues/1552 lands.

import type { UserConfirmationReview } from '@parity/truapi-host';
import { captureException, m, spans as S } from '@dotli/metrics';
import { log } from '@dotli/shared';
import type { PhoneAsk } from '../components/signing/phone-waiting-view.js';
import { PHONE_REQUEST_CODECS, type PhoneMethod, type PhoneRequest } from './phone-requests.js';

export interface PhoneReviewMatch {
  /** Whether `request` is the one the review was shown for. */
  matches: (request: PhoneRequest) => boolean;
  /** What the phone is asked to do, which words the waiting step. */
  ask: PhoneAsk;
}

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
  return PHONE_REQUEST_CODECS[method].request.enc({ tag: 'V1', value });
}

function reportEncodeFailure(method: PhoneMethod, error: unknown): void {
  captureException(error, { flow: 'wallet', step: 'phone_review_match', tags: { method } });
  log.error(`[dot.li phone review] ${method} did not encode for matching:`, error);
  m.count(S.PHONE_REQUEST, { outcome: 'error', reason: 'encode' });
}

/**
 * Matches a request of one of `methods` whose V1 encoding equals that of `value`. With `callData`, the request's
 * call data is read as `callData` (the core rewrites it for declared contacts before it builds the review).
 */
function byRequest(
  ask: PhoneAsk,
  methods: PhoneMethod[],
  value: unknown,
  callData?: { review: string },
): PhoneReviewMatch {
  try {
    const encoded = new Map(methods.map(method => [method, encodeV1(method, value)]));
    return {
      ask,
      matches: request => {
        const expected = encoded.get(request.method);
        if (expected === undefined) {
          return false;
        }
        try {
          let body = withNormalizedProductIds(request.body);
          if (callData !== undefined) {
            body = { ...(body as object), callData: callData.review };
          }
          return sameBytes(expected, encodeV1(request.method, body));
        } catch (error) {
          reportEncodeFailure(request.method, error);
          return false;
        }
      },
    };
  } catch (error) {
    reportEncodeFailure(methods[0] ?? 'signPayload', error);
    return { ask, matches: () => false };
  }
}

/** Matches a `getAccount` request for an account of `productId`. */
function byAccountOf(productId: string): PhoneReviewMatch {
  return {
    ask: 'approve',
    matches: request =>
      request.method === 'getAccount' &&
      (request.body as { productAccountId: { dotNsIdentifier: string } }).productAccountId.dotNsIdentifier
        .trim()
        .normalize('NFC')
        .toLowerCase() === productId,
  };
}

/** How to find the request behind `review`, or undefined for a review that never waits on the phone. */
export function phoneReviewMatch(review: UserConfirmationReview): PhoneReviewMatch | undefined {
  switch (review.tag) {
    case 'SignPayload':
      return review.value.tag === 'Product'
        ? byRequest('sign', ['signPayload'], review.value.value.request)
        : byRequest('sign', ['signPayloadWithLegacyAccount'], review.value.value);
    case 'SignRaw':
      return review.value.tag === 'Product'
        ? byRequest('sign', ['signRaw', 'signRawUnwatermarkedDeprecated'], review.value.value.request)
        : byRequest(
            'sign',
            ['signRawWithLegacyAccount', 'signRawUnwatermarkedDeprecatedWithLegacyAccount'],
            review.value.value.request,
          );
    case 'CreateTransaction':
      return review.value.tag === 'Product'
        ? byRequest(
            'sign',
            ['createTransaction'],
            review.value.value.payload,
            review.value.value.payload.contacts.length > 0
              ? { review: review.value.value.payload.callData }
              : undefined,
          )
        : byRequest('sign', ['createTransactionWithLegacyAccount'], review.value.value);
    case 'SignVrf':
      return byRequest('sign', ['signVrf'], review.value.request);
    case 'ResourceAllocation':
      return byRequest('approve', ['requestResourceAllocation'], { resources: review.value.resources });
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
