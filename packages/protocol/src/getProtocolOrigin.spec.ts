// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { BASE_DOMAIN, DEV_HOST_PORT } from '@dotli/config';
import { getProtocolOrigin } from './getProtocolOrigin.js';

describe('getProtocolOrigin', () => {
  it('As a page on a product host, I get the root domain as the frame origin', () => {
    // Given a deployed product host
    const env = { localRoot: null, dev: false, protocol: 'https:', port: '' };

    // When the frame origin is read
    const origin = getProtocolOrigin(env);

    // Then it is the root domain's origin
    expect(origin).toBe(`https://${BASE_DOMAIN}`);
  });

  it("As a page in development on a port other than the host's, I still get the host's dev port for the frame", () => {
    // Given a development page served on another port
    const env = { localRoot: 'localhost', dev: true, protocol: 'https:', port: '9999' };

    // When the frame origin is read
    const origin = getProtocolOrigin(env);

    // Then the origin uses the host's dev port
    expect(origin).toBe(`https://localhost:${DEV_HOST_PORT}`);
  });

  it('As a page under preview on port 5180, I get localhost:5180', () => {
    // Given a page under preview on localhost
    const env = { localRoot: 'localhost', dev: false, protocol: 'http:', port: '5180' };

    // When the frame origin is read
    const origin = getProtocolOrigin(env);

    // Then it is localhost on the preview port
    expect(origin).toBe('http://localhost:5180');
  });
});
