// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { RemotePermission } from '@parity/truapi';
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
});
