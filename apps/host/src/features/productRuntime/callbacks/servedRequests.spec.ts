// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { RemotePermission } from '@parity/truapi';
import { servedRequests, type ServeRule } from './servedRequests.js';

const REMOTE_RULES: [RemotePermission['tag'], ServeRule][] = [
  ['ChainSubmit', { kind: 'prompt', name: 'ChainSubmit' }],
  ['Remote', { kind: 'grant' }],
  ['BalanceAccess', { kind: 'refuse' }],
];

describe('servedRequests', () => {
  it.each(REMOTE_RULES)('As the host, I answer the remote permission %s by its rule', (tag, rule) => {
    // Given a remote permission tag
    // When the host looks up its rule
    const result = servedRequests.getRemoteRule(tag);

    // Then the rule is the one that tag has
    expect(result).toEqual(rule);
  });

  it('As the host, I grant OpenUrl at once, deny NFC at once, leave the camera to the browser and ask for notifications', () => {
    // Given the device permission the host cannot enforce, the one dot.li does not support, one the browser asks for
    // itself, and one the host asks for
    // When the host looks up each rule
    const openUrl = servedRequests.getDeviceRule('OpenUrl');
    const nfc = servedRequests.getDeviceRule('NFC');
    const camera = servedRequests.getDeviceRule('Camera');
    const notifications = servedRequests.getDeviceRule('Notifications');

    // Then OpenUrl is granted, NFC is denied, the camera is the browser's, and notifications are asked
    expect([openUrl, nfc, camera, notifications]).toEqual([
      { kind: 'grant' },
      { kind: 'deny' },
      { kind: 'browser', name: 'Camera' },
      { kind: 'prompt', name: 'Notifications' },
    ]);
  });
});
