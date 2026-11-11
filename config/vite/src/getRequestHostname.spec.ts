// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getRequestHostname } from './getRequestHostname.js';

describe('getRequestHostname', () => {
  it('As a visitor on the https dev server, I send an HTTP/2 request whose :authority names the host and reach my product', () => {
    // Given an HTTP/2 request's headers
    const headers = { ':authority': 'browse.localhost:4321' };

    // When the host is read from them
    const hostname = getRequestHostname(headers);

    // Then it is the :authority host without its port
    expect(hostname).toBe('browse.localhost');
  });

  it('As a visitor over HTTP/1.1, I send a request and its Host header names the host', () => {
    // Given an HTTP/1.1 request's headers
    const headers = { host: 'browse.localhost:5173' };

    // When the host is read from them
    const hostname = getRequestHostname(headers);

    // Then it is the Host header without its port
    expect(hostname).toBe('browse.localhost');
  });

  it('As a visitor on the IPv6 loopback, I send a request whose Host header names it in brackets and get the address whole', () => {
    // Given a request's headers with a bracketed IPv6 host and a port
    const headers = { host: '[::1]:4001' };

    // When the host is read from them
    const hostname = getRequestHostname(headers);

    // Then it is the bracketed address without its port
    expect(hostname).toBe('[::1]');
  });
});
