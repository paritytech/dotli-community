// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ContactHandle, HostSignPayloadData } from '@parity/truapi';
import type { UserConfirmationReview } from '@parity/truapi-host';
import { describe, expect, it, vi } from 'vitest';
import type { PhoneMethod } from './phone-methods.js';
import { phoneReviewMatch } from './phone-review-match.js';
import type { PhoneRequest } from './phone-requests.js';

function requestOf(method: PhoneMethod, body: unknown): PhoneRequest {
  return { method, body };
}

type Hex = `0x${string}`;

const account = (id: string) => ({ dotNsIdentifier: id, derivationIndex: { tag: 'Index' as const, value: 0 } });

const signPayloadData = (nonce: Hex): HostSignPayloadData => ({
  blockHash: '0x01',
  blockNumber: '0x02',
  era: '0x03',
  genesisHash: '0x04',
  method: '0x05',
  nonce,
  specVersion: '0x07',
  tip: '0x08',
  transactionVersion: '0x09',
  signedExtensions: [],
  version: 4,
});

const txPayload = (callData: Hex) => ({
  signer: account('product.dot'),
  genesisHash: '0x04' as Hex,
  callData,
  extensions: [],
  txExtVersion: 0,
  contacts: [],
});

const legacyTxPayload = (callData: Hex) => ({
  signer: '0x0a' as Hex,
  genesisHash: '0x04' as Hex,
  callData,
  extensions: [],
  txExtVersion: 0,
});

const rawPayload = (payload: Hex) => ({ tag: 'Payload' as const, value: { payload } });

const signRaw = (id: string, payload: Hex) => ({ account: account(id), payload: rawPayload(payload) });

const allowance = (index: number) => ({
  tag: 'SmartContractAllowance' as const,
  value: { tag: 'Index' as const, value: index },
});

const vrf = (message: Hex) => ({
  account: account('product.dot'),
  transcriptLabel: message,
  items: [],
});

const signPayloadReview: UserConfirmationReview = {
  tag: 'SignPayload',
  value: {
    tag: 'Product',
    value: {
      callingProductId: 'product.dot',
      request: { account: account('product.dot'), payload: signPayloadData('0x06') },
    },
  },
};

interface Row {
  name: string;
  review: UserConfirmationReview;
  matching: PhoneRequest[];
  differing: PhoneRequest;
}

const rows: Row[] = [
  {
    name: 'product sign-payload review',
    review: signPayloadReview,
    matching: [requestOf('signPayload', { account: account('product.dot'), payload: signPayloadData('0x06') })],
    differing: requestOf('signPayload', { account: account('product.dot'), payload: signPayloadData('0x99') }),
  },
  {
    name: 'legacy sign-payload review',
    review: {
      tag: 'SignPayload',
      value: { tag: 'LegacyAccount', value: { signer: '0x0a', payload: signPayloadData('0x06') } },
    },
    matching: [requestOf('signPayloadWithLegacyAccount', { signer: '0x0a', payload: signPayloadData('0x06') })],
    differing: requestOf('signPayloadWithLegacyAccount', { signer: '0x0b', payload: signPayloadData('0x06') }),
  },
  {
    name: 'product sign-raw review',
    review: {
      tag: 'SignRaw',
      value: { tag: 'Product', value: { request: signRaw('product.dot', '0xaa'), watermarked: true } },
    },
    matching: [
      requestOf('signRaw', signRaw('product.dot', '0xaa')),
      requestOf('signRawUnwatermarkedDeprecated', signRaw('product.dot', '0xaa')),
    ],
    differing: requestOf('signRaw', signRaw('product.dot', '0xbb')),
  },
  {
    name: 'legacy sign-raw review',
    review: {
      tag: 'SignRaw',
      value: {
        tag: 'LegacyAccount',
        value: { request: { signer: '0x0a', payload: rawPayload('0xaa') }, watermarked: false },
      },
    },
    matching: [
      requestOf('signRawWithLegacyAccount', { signer: '0x0a', payload: rawPayload('0xaa') }),
      requestOf('signRawUnwatermarkedDeprecatedWithLegacyAccount', { signer: '0x0a', payload: rawPayload('0xaa') }),
    ],
    differing: requestOf('signRawWithLegacyAccount', { signer: '0x0a', payload: rawPayload('0xbb') }),
  },
  {
    name: 'product create-transaction review',
    review: { tag: 'CreateTransaction', value: { tag: 'Product', value: { payload: txPayload('0x01') } } },
    matching: [requestOf('createTransaction', txPayload('0x01'))],
    differing: requestOf('createTransaction', txPayload('0x02')),
  },
  {
    name: 'legacy create-transaction review',
    review: { tag: 'CreateTransaction', value: { tag: 'LegacyAccount', value: legacyTxPayload('0x01') } },
    matching: [requestOf('createTransactionWithLegacyAccount', legacyTxPayload('0x01'))],
    differing: requestOf('createTransactionWithLegacyAccount', legacyTxPayload('0x02')),
  },
  {
    name: 'sign-vrf review',
    review: { tag: 'SignVrf', value: { callingProductId: 'product.dot', request: vrf('0xaa') } },
    matching: [requestOf('signVrf', vrf('0xaa'))],
    differing: requestOf('signVrf', vrf('0xbb')),
  },
  {
    name: 'resource allocation review',
    review: {
      tag: 'ResourceAllocation',
      value: { callingProductId: 'product.dot', resources: [allowance(1)] },
    },
    matching: [requestOf('requestResourceAllocation', { resources: [allowance(1)] })],
    differing: requestOf('requestResourceAllocation', { resources: [allowance(2)] }),
  },
  {
    name: 'product subtree review',
    review: { tag: 'ProductSubtree', value: { productId: 'product.dot' } },
    matching: [requestOf('getAccount', { productAccountId: account('product.dot') })],
    differing: requestOf('getAccount', { productAccountId: account('other.dot') }),
  },
  {
    name: 'account access review',
    review: { tag: 'AccountAccess', value: { requestingProductId: 'product.dot', targetProductId: 'target.dot' } },
    matching: [requestOf('getAccount', { productAccountId: account('target.dot') })],
    differing: requestOf('getAccount', { productAccountId: account('product.dot') }),
  },
];

describe('phone review match', () => {
  it.each(rows)('As a host, a $name matches only its own request', ({ review, matching, differing }) => {
    // Given
    const match = phoneReviewMatch(review);

    // When
    const results = matching.map(request => match?.(request));
    const other = match?.(differing);

    // Then
    expect(results).toEqual(matching.map(() => true));
    expect(other).toBe(false);
  });

  it('As a host, a sign review does not match a request of another method', () => {
    // Given
    const match = phoneReviewMatch(signPayloadReview);

    // When
    const result = match?.(requestOf('createTransaction', txPayload('0x01')));

    // Then
    expect(result).toBe(false);
  });

  it('As a host, an identity disclosure review never waits on the phone', () => {
    // Given
    const review: UserConfirmationReview = { tag: 'IdentityDisclosure', value: { productId: 'product.dot' } };

    // When
    const match = phoneReviewMatch(review);

    // Then
    expect(match).toBeUndefined();
  });
});

describe('phone review match against the core rewrites', () => {
  const productTx = (callData: Hex, contacts: ContactHandle[]) => ({ ...txPayload(callData), contacts });
  const txReview = (payload: ReturnType<typeof productTx>): UserConfirmationReview => ({
    tag: 'CreateTransaction',
    value: { tag: 'Product', value: { payload } },
  });

  it('As a host, a create-transaction review with contacts matches its request despite the rewritten call data', () => {
    // Given
    const contacts: ContactHandle[] = [{ bytes: `0x${'11'.repeat(32)}` }];
    const match = phoneReviewMatch(txReview(productTx('0xbeef', contacts)));

    // When
    const same = match?.(requestOf('createTransaction', productTx('0x01', contacts)));
    const other = match?.(requestOf('createTransaction', { ...productTx('0x01', contacts), genesisHash: '0x05' }));

    // Then
    expect(same).toBe(true);
    expect(other).toBe(false);
  });

  it('As a host, a review matches a request whose product id is spelled differently', () => {
    // Given
    const request = (id: string) => requestOf('signVrf', { ...vrf('0xaa'), account: account(id) });
    const vrfMatch = phoneReviewMatch({
      tag: 'SignVrf',
      value: { callingProductId: 'product.dot', request: vrf('0xaa') },
    });
    const accessMatch = phoneReviewMatch({
      tag: 'AccountAccess',
      value: { requestingProductId: 'a.dot', targetProductId: 'target.dot' },
    });

    // When
    const spelled = vrfMatch?.(request('  Product.DOT '));
    const getAccount = accessMatch?.(requestOf('getAccount', { productAccountId: account(' Target.Dot') }));

    // Then
    expect(spelled).toBe(true);
    expect(getAccount).toBe(true);
  });

  it('As a host, a review that cannot be encoded matches nothing and does not throw', () => {
    // Given
    const review: UserConfirmationReview = {
      tag: 'SignVrf',
      value: { callingProductId: 'p.dot', request: {} as never },
    };

    // When
    const reportEncodeFailure = vi.fn();
    const match = phoneReviewMatch(review, { reportEncodeFailure });

    // Then
    expect(match?.(requestOf('signVrf', vrf('0xaa')))).toBe(false);
    expect(reportEncodeFailure).toHaveBeenCalledWith('signVrf', expect.anything());
  });

  it('As a host, a review that cannot be encoded reports nothing until a request is matched against it', () => {
    // Given
    const reportEncodeFailure = vi.fn();
    const match = phoneReviewMatch(
      { tag: 'SignVrf', value: { callingProductId: 'p.dot', request: {} as never } },
      { reportEncodeFailure },
    );

    // Then
    expect(reportEncodeFailure).not.toHaveBeenCalled();

    // When
    match?.(requestOf('signVrf', vrf('0xaa')));
    match?.(requestOf('signVrf', vrf('0xbb')));

    // Then
    expect(reportEncodeFailure).toHaveBeenCalledOnce();
  });
});
