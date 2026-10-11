// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { parseReceivingOrigins, receivingConfigForOrigin } from '../src/receiving.js';

const t3ams = {
  origin: 'https://t3ams-push-test.paseo.fyi',
  relayUrl: 'https://t3ams-push-test.paseo.fyi/__receiving',
  vapidPublicKey: `B${'A'.repeat(86)}`,
  proxyPort: 8789,
};
const echat = {
  origin: 'https://echat-new.paseo.fyi',
  relayUrl: 'https://echat-new.paseo.fyi/__receiving',
  vapidPublicKey: `B${'B'.repeat(85)}A`,
  proxyPort: 8790,
};

describe('exact receiving origin configuration', () => {
  it('selects independent relay and VAPID authorities from the same build', () => {
    const entries = parseReceivingOrigins(JSON.stringify([t3ams, echat]));
    expect(receivingConfigForOrigin(entries, t3ams.origin)).toEqual(t3ams);
    expect(receivingConfigForOrigin(entries, echat.origin)).toEqual(echat);
  });

  it.each([
    'https://paseo.fyi',
    'https://host.paseo.fyi',
    'https://cid.app.paseo.fyi',
    'https://other.paseo.fyi',
    'https://echat-new.paseo.fyi.attacker.test',
    'https://child.echat-new.paseo.fyi',
    'http://echat-new.paseo.fyi',
    'https://echat-new.paseo.fyi:444',
    'https://echat-new.paseo.fyi/',
  ])('does not borrow an authority for %s', origin => {
    expect(receivingConfigForOrigin(parseReceivingOrigins(JSON.stringify([t3ams, echat])), origin)).toBeUndefined();
  });

  it.each([undefined, '', '  ', '[]'])('keeps missing configuration unsupported: %s', value => {
    expect(parseReceivingOrigins(value)).toEqual([]);
  });

  it.each([
    { origin: 'https://*.paseo.fyi' },
    { origin: 'https://echat-new.paseo.fyi/' },
    { origin: 'https://echat-new.paseo.fyi:443' },
    { origin: 'http://echat-new.paseo.fyi' },
    { relayUrl: 'https://user:password@relay.example' },
    { relayUrl: 'https://relay.example?key=x' },
    { relayUrl: 'https://relay.example/#fragment' },
    { relayUrl: 'https://relay.example/";return 200;' },
    { vapidPublicKey: '' },
    { vapidPublicKey: undefined },
    { vapidPublicKey: 'private-key' },
    { proxyPort: 0 },
    { proxyPort: 65536 },
    { proxyPort: '8790' },
    { proxyPort: 8790.5 },
    { relayUrl: 'https://other.paseo.fyi/__receiving' },
    { productId: 'untrusted' },
  ])('rejects partial, unsafe or mismatched entries: %j', change => {
    expect(() => parseReceivingOrigins(JSON.stringify([t3ams, { ...echat, ...change }]))).toThrow();
  });

  it('rejects duplicate origins, endpoints and loopback ports rather than choosing the first', () => {
    for (const second of [
      t3ams,
      { ...echat, proxyPort: 8789 },
      { ...echat, relayUrl: t3ams.relayUrl, proxyPort: undefined },
    ]) {
      expect(() => parseReceivingOrigins(JSON.stringify([t3ams, second]))).toThrow();
    }
    expect(() => parseReceivingOrigins(JSON.stringify({ [t3ams.origin]: t3ams }))).toThrow();
  });

  it('supports a dedicated external relay without creating a local proxy', () => {
    const entries = parseReceivingOrigins(
      JSON.stringify([{ ...echat, relayUrl: 'https://relay.example/echat/', proxyPort: undefined }]),
    );
    expect(entries[0]).toEqual({ ...echat, relayUrl: 'https://relay.example/echat', proxyPort: undefined });
  });
});
