// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { asProductId, type ContactHandle, type HostSignPayloadData } from '@parity/truapi';
import { describe, expect, it, vi } from 'vitest';
import type { PhoneMethod } from './phoneMethods.js';
import { matchPhoneReview } from './matchPhoneReview.js';
import type { PhoneRequest } from './createPhoneRequestTracker.js';
import type { ServedReview } from './hostCallbacks/servedRequests.js';

type Hex = `0x${string}`;

type Row = {
  name: string;
  review: ServedReview;
  matching: PhoneRequest[];
  differing: PhoneRequest;
};

const GENESIS_HASH: Hex = '0x04';
const LEGACY_SIGNER: Hex = '0x0a';

const SIGN_PAYLOAD_REVIEW: ServedReview = {
  tag: 'SignPayload',
  value: {
    tag: 'Product',
    value: {
      callingProductId: asProductId('product.dot'),
      request: { account: buildAccount('product.dot'), payload: buildSignPayloadData('0x06') },
    },
  },
};

const ROWS: Row[] = [
  {
    name: 'product sign-payload review',
    review: SIGN_PAYLOAD_REVIEW,
    matching: [
      buildRequest('signPayload', { account: buildAccount('product.dot'), payload: buildSignPayloadData('0x06') }),
    ],
    differing: buildRequest('signPayload', {
      account: buildAccount('product.dot'),
      payload: buildSignPayloadData('0x99'),
    }),
  },
  {
    name: 'legacy sign-payload review',
    review: {
      tag: 'SignPayload',
      value: { tag: 'LegacyAccount', value: { signer: '0x0a', payload: buildSignPayloadData('0x06') } },
    },
    matching: [buildRequest('signPayloadWithLegacyAccount', { signer: '0x0a', payload: buildSignPayloadData('0x06') })],
    differing: buildRequest('signPayloadWithLegacyAccount', { signer: '0x0b', payload: buildSignPayloadData('0x06') }),
  },
  {
    name: 'product sign-raw review',
    review: {
      tag: 'SignRaw',
      value: { tag: 'Product', value: { request: buildSignRaw('product.dot', '0xaa'), watermarked: true } },
    },
    matching: [
      buildRequest('signRaw', buildSignRaw('product.dot', '0xaa')),
      buildRequest('signRawUnwatermarkedDeprecated', buildSignRaw('product.dot', '0xaa')),
    ],
    differing: buildRequest('signRaw', buildSignRaw('product.dot', '0xbb')),
  },
  {
    name: 'legacy sign-raw review',
    review: {
      tag: 'SignRaw',
      value: {
        tag: 'LegacyAccount',
        value: { request: { signer: '0x0a', payload: buildRawPayload('0xaa') }, watermarked: false },
      },
    },
    matching: [
      buildRequest('signRawWithLegacyAccount', { signer: '0x0a', payload: buildRawPayload('0xaa') }),
      buildRequest('signRawUnwatermarkedDeprecatedWithLegacyAccount', {
        signer: '0x0a',
        payload: buildRawPayload('0xaa'),
      }),
    ],
    differing: buildRequest('signRawWithLegacyAccount', { signer: '0x0a', payload: buildRawPayload('0xbb') }),
  },
  {
    name: 'product create-transaction review',
    review: { tag: 'CreateTransaction', value: { tag: 'Product', value: { payload: buildTxPayload('0x01') } } },
    matching: [buildRequest('createTransaction', buildTxPayload('0x01'))],
    differing: buildRequest('createTransaction', buildTxPayload('0x02')),
  },
  {
    name: 'legacy create-transaction review',
    review: { tag: 'CreateTransaction', value: { tag: 'LegacyAccount', value: buildLegacyTxPayload('0x01') } },
    matching: [buildRequest('createTransactionWithLegacyAccount', buildLegacyTxPayload('0x01'))],
    differing: buildRequest('createTransactionWithLegacyAccount', buildLegacyTxPayload('0x02')),
  },
  {
    name: 'sign-vrf review',
    review: { tag: 'SignVrf', value: { callingProductId: asProductId('product.dot'), request: buildVrf('0xaa') } },
    matching: [buildRequest('signVrf', buildVrf('0xaa'))],
    differing: buildRequest('signVrf', buildVrf('0xbb')),
  },
  {
    name: 'resource allocation review',
    review: {
      tag: 'ResourceAllocation',
      value: { callingProductId: asProductId('product.dot'), resources: [buildAllowance(1)] },
    },
    matching: [buildRequest('requestResourceAllocation', { resources: [buildAllowance(1)] })],
    differing: buildRequest('requestResourceAllocation', { resources: [buildAllowance(2)] }),
  },
  {
    name: 'product subtree review',
    review: { tag: 'ProductSubtree', value: { productId: asProductId('product.dot') } },
    matching: [buildRequest('getAccount', { productAccountId: buildAccount('product.dot') })],
    differing: buildRequest('getAccount', { productAccountId: buildAccount('other.dot') }),
  },
  {
    name: 'account access review',
    review: {
      tag: 'AccountAccess',
      value: { requestingProductId: asProductId('product.dot'), targetProductId: asProductId('target.dot') },
    },
    matching: [buildRequest('getAccount', { productAccountId: buildAccount('target.dot') })],
    differing: buildRequest('getAccount', { productAccountId: buildAccount('product.dot') }),
  },
];

describe('phone review match', () => {
  it.each(ROWS)(
    'As a dotli integrator, I match a $name against phone requests and only its own request matches',
    ({ review, matching, differing }) => {
      // Given
      const match = matchPhoneReview(review);

      // When
      const results = matching.map(request => match?.(request));
      const other = match?.(differing);

      // Then
      expect(results).toEqual(matching.map(() => true));
      expect(other).toBe(false);
    },
  );

  it('As a dotli integrator, I match a sign review against a request of another method and it does not match', () => {
    // Given
    const match = matchPhoneReview(SIGN_PAYLOAD_REVIEW);

    // When
    const result = match?.(buildRequest('createTransaction', buildTxPayload('0x01')));

    // Then
    expect(result).toBe(false);
  });

  it('As a Polkadot App user, I review an identity disclosure and it never waits on the phone', () => {
    // Given
    const review: ServedReview = {
      tag: 'IdentityDisclosure',
      value: { productId: asProductId('product.dot') },
    };

    // When
    const match = matchPhoneReview(review);

    // Then
    expect(match).toBeUndefined();
  });
});

describe('phone review match against the core rewrites', () => {
  it('As a dotli integrator, I match a create-transaction review with contacts and its request matches despite the rewritten call data', () => {
    // Given
    const contacts: ContactHandle[] = [{ bytes: `0x${'11'.repeat(32)}` }];
    const match = matchPhoneReview(buildTxReview(buildProductTx('0xbeef', contacts)));

    // When
    const same = match?.(buildRequest('createTransaction', buildProductTx('0x01', contacts)));
    const other = match?.(
      buildRequest('createTransaction', { ...buildProductTx('0x01', contacts), genesisHash: '0x05' }),
    );

    // Then
    expect(same).toBe(true);
    expect(other).toBe(false);
  });

  it('As a dotli integrator, I match a review against a request whose product id is spelled differently and it matches', () => {
    // Given
    const vrfMatch = matchPhoneReview({
      tag: 'SignVrf',
      value: { callingProductId: asProductId('product.dot'), request: buildVrf('0xaa') },
    });
    const accessMatch = matchPhoneReview({
      tag: 'AccountAccess',
      value: { requestingProductId: asProductId('a.dot'), targetProductId: asProductId('target.dot') },
    });

    // When
    const spelled = vrfMatch?.(
      buildRequest('signVrf', { ...buildVrf('0xaa'), account: buildAccount('  Product.DOT ') }),
    );
    const getAccount = accessMatch?.(buildRequest('getAccount', { productAccountId: buildAccount(' Target.Dot') }));

    // Then
    expect(spelled).toBe(true);
    expect(getAccount).toBe(true);
  });

  it('As a dotli integrator, I match against a review that cannot be encoded and nothing matches, with no throw', () => {
    // Given
    const review: ServedReview = {
      tag: 'SignVrf',
      // A request the codec cannot encode, which no typed value can be.
      value: { callingProductId: asProductId('p.dot'), request: {} as never },
    };
    const reportEncodeFailure = vi.fn();

    // When
    const match = matchPhoneReview(review, { reportEncodeFailure });
    const result = match?.(buildRequest('signVrf', buildVrf('0xaa')));

    // Then
    expect(result).toBe(false);
    expect(reportEncodeFailure).toHaveBeenCalledWith('signVrf', expect.anything());
  });

  it('As a dotli integrator, I build a match for a review that cannot be encoded and it reports once, only when a request is matched', () => {
    // Given
    const reportEncodeFailure = vi.fn();
    const match = matchPhoneReview(
      // A request the codec cannot encode, which no typed value can be.
      { tag: 'SignVrf', value: { callingProductId: asProductId('p.dot'), request: {} as never } },
      { reportEncodeFailure },
    );
    const reportsBeforeMatch = reportEncodeFailure.mock.calls.length;

    // When
    match?.(buildRequest('signVrf', buildVrf('0xaa')));
    match?.(buildRequest('signVrf', buildVrf('0xbb')));

    // Then
    expect(reportsBeforeMatch).toBe(0);
    expect(reportEncodeFailure).toHaveBeenCalledOnce();
  });
});

function buildRequest(method: PhoneMethod, body: unknown): PhoneRequest {
  return { method, body };
}

function buildAccount(id: string) {
  return { dotNsIdentifier: asProductId(id), derivationIndex: { tag: 'Index' as const, value: 0 } };
}

function buildSignPayloadData(nonce: Hex): HostSignPayloadData {
  return {
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
  };
}

function buildTxPayload(callData: Hex) {
  return {
    signer: buildAccount('product.dot'),
    genesisHash: GENESIS_HASH,
    callData,
    extensions: [],
    txExtVersion: 0,
    contacts: [],
  };
}

function buildLegacyTxPayload(callData: Hex) {
  return {
    signer: LEGACY_SIGNER,
    genesisHash: GENESIS_HASH,
    callData,
    extensions: [],
    txExtVersion: 0,
  };
}

function buildRawPayload(payload: Hex) {
  return { tag: 'Payload' as const, value: { payload } };
}

function buildSignRaw(id: string, payload: Hex) {
  return { account: buildAccount(id), payload: buildRawPayload(payload) };
}

function buildAllowance(index: number) {
  return {
    tag: 'SmartContractAllowance' as const,
    value: { tag: 'Index' as const, value: index },
  };
}

function buildVrf(message: Hex) {
  return {
    account: buildAccount('product.dot'),
    transcriptLabel: message,
    items: [],
  };
}

function buildProductTx(callData: Hex, contacts: ContactHandle[]) {
  return { ...buildTxPayload(callData), contacts };
}

function buildTxReview(payload: ReturnType<typeof buildProductTx>): ServedReview {
  return {
    tag: 'CreateTransaction',
    value: { tag: 'Product', value: { payload } },
  };
}
