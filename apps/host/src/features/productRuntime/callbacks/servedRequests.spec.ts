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

  it('As the host, I grant OpenUrl at once, leave the camera to the browser and ask for NFC', () => {
    // Given the one device permission the host cannot enforce, one the browser asks for itself, and one the host asks for
    // When the host looks up each rule
    const openUrl = servedRequests.getDeviceRule('OpenUrl');
    const camera = servedRequests.getDeviceRule('Camera');
    const nfc = servedRequests.getDeviceRule('NFC');

    // Then
    expect([openUrl, camera, nfc]).toEqual([
      { kind: 'grant' },
      { kind: 'browser', name: 'Camera' },
      { kind: 'prompt', name: 'NFC' },
    ]);
  });
});
