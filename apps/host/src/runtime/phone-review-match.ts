// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Temporary: the core does not report phone requests to the host, so this infers them from relayed frames. Remove once https://github.com/paritytech/trinity-user-agents/issues/1552 lands.

import type { UserConfirmationReview } from '@parity/truapi-host';
import type { PhoneAsk } from '../components/signing/phone-waiting-view.js';
import { PHONE_REQUEST_CODECS, type PhoneMethod, type PhoneRequest } from './phone-requests.js';

export interface PhoneReviewMatch {
  /** Whether `request` is the one the review was shown for. */
  matches: (request: PhoneRequest) => boolean;
  ask: PhoneAsk;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** Matches a request of one of `methods` whose V1 encoding equals that of `value`. */
function byRequest(ask: PhoneAsk, methods: PhoneMethod[], value: unknown): PhoneReviewMatch {
  const encoded = new Map(
    methods.map(method => [method, PHONE_REQUEST_CODECS[method].request.enc({ tag: 'V1', value })]),
  );
  return {
    ask,
    matches: request => {
      const expected = encoded.get(request.method);
      return expected !== undefined && sameBytes(expected, request.bytes);
    },
  };
}

/** Matches a `getAccount` request for an account of `productId`. */
function byAccountOf(productId: string): PhoneReviewMatch {
  return {
    ask: 'approve',
    matches: request =>
      request.method === 'getAccount' &&
      (request.body as { productAccountId: { dotNsIdentifier: string } }).productAccountId.dotNsIdentifier ===
        productId,
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
        ? byRequest('sign', ['createTransaction'], review.value.value.payload)
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
