// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { jamPeerTransportUnavailableMessage } from '../src/jam-peer-browser-support.js';

const REQUIREMENTS = 'Chrome or Edge 100+, Firefox 125+, or Safari/iOS 26.4+';

describe('JAM peer browser compatibility guidance', () => {
  it.each([
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 26_3 like Mac OS X) AppleWebKit/605.1.15 Version/26.3 Mobile/15E148 Safari/604.1',
      'iOS 26.3',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.3 Safari/605.1.15',
      'Safari 26.3',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/99.0.4844.51 Safari/537.36',
      'Chrome 99.0.4844.51',
    ],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0', 'Firefox 124.0'],
  ])('names the current browser version and supported versions for %s', (userAgent, currentBrowser) => {
    const message = jamPeerTransportUnavailableMessage(userAgent);

    expect(message).toContain(`${currentBrowser} does not provide the WebTransport support`);
    expect(message).toContain(REQUIREMENTS);
    expect(message).toContain('verified snapshot instead');
  });

  it('uses generic copy when the browser cannot be identified', () => {
    expect(jamPeerTransportUnavailableMessage('CustomBrowser/1.0')).toBe(
      `This browser does not provide the WebTransport support required for live JAM connections. Use ${REQUIREMENTS}. This app will use its verified snapshot instead.`,
    );
  });
});
