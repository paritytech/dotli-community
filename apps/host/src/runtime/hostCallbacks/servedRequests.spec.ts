// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { asProductId, type RemotePermission } from '@parity/truapi';
import type { UserConfirmationReview } from '@parity/truapi-host';
import { servedRequests, type ServeRule } from './servedRequests.js';

const REMOTE_RULES: [RemotePermission['tag'], ServeRule][] = [
  ['ChainSubmit', { kind: 'prompt', name: 'ChainSubmit' }],
  ['PreimageSubmit', { kind: 'prompt', name: 'PreimageSubmit' }],
  ['StatementSubmit', { kind: 'prompt', name: 'StatementSubmit' }],
  ['Remote', { kind: 'grant' }],
  ['WebRtc', { kind: 'grant' }],
  ['BalanceAccess', { kind: 'refuse' }],
  ['NftPurseRead', { kind: 'refuse' }],
];

const DRAIN_REVIEW: UserConfirmationReview = {
  tag: 'NftPurseDrain',
  value: {
    callingProductId: asProductId('product.dot'),
    fromPurse: 1,
    owner: { tag: 'Root' },
    itemCount: 2,
    destination: { tag: 'Purse', value: { purse: 2 } },
  },
};

const SIGN_PAYLOAD_REVIEW: UserConfirmationReview = {
  tag: 'SignPayload',
  value: {
    tag: 'LegacyAccount',
    value: {
      signer: '0x0a',
      payload: {
        blockHash: '0x01',
        blockNumber: '0x02',
        era: '0x03',
        genesisHash: '0x04',
        method: '0x05',
        nonce: '0x06',
        specVersion: '0x07',
        tip: '0x08',
        transactionVersion: '0x09',
        signedExtensions: [],
        version: 4,
      },
    },
  },
};

describe('servedRequests', () => {
  it.each(REMOTE_RULES)('As the host, I answer the remote permission %s by its rule', (tag, rule) => {
    // Given a remote permission tag
    // When the host looks up its rule
    const result = servedRequests.getRemoteRule(tag);

    // Then the rule is the one that tag has
    expect(result).toEqual(rule);
  });

  it('As the host, I grant OpenUrl at once and ask for every other device permission', () => {
    // Given the one device permission the host cannot enforce, and one it can
    // When the host looks up each rule
    const openUrl = servedRequests.getDeviceRule('OpenUrl');
    const camera = servedRequests.getDeviceRule('Camera');

    // Then OpenUrl is granted and Camera is asked
    expect(openUrl).toEqual({ kind: 'grant' });
    expect(camera).toEqual({ kind: 'prompt', name: 'Camera' });
  });

  it('As the host, I show every review but an NFT purse drain', () => {
    // Given a drain review and a sign review
    // When the host asks whether it serves each
    const servedDrain = servedRequests.isServed(DRAIN_REVIEW);
    const servedSign = servedRequests.isServed(SIGN_PAYLOAD_REVIEW);

    // Then only the sign review is served
    expect(servedDrain).toBe(false);
    expect(servedSign).toBe(true);
  });
});
