// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { readSandboxFraming } from './readSandboxFraming.js';

const BASE_DOMAIN = 'dot.li';

describe('readSandboxFraming', () => {
  it('As a sandbox framed on its own product subdomain, I am cleared to ask the host for my contract', () => {
    // When
    const framing = readSandboxFraming({ href: 'https://myapp.app.dot.li/?q=mine', framed: true }, BASE_DOMAIN);

    // Then
    expect(framing).toEqual({ kind: 'onOrigin' });
  });

  it('As a sandbox framed on the bare app root rather than a product subdomain, I am off origin', () => {
    // When
    const framing = readSandboxFraming({ href: 'https://app.dot.li/', framed: true }, BASE_DOMAIN);

    // Then
    expect(framing).toEqual({ kind: 'offOrigin' });
  });

  it('As a developer framed on a local product subdomain, I am cleared to ask for my contract', () => {
    // When
    const framing = readSandboxFraming({ href: 'https://myapp.app.local.host:4322/', framed: true }, BASE_DOMAIN);

    // Then
    expect(framing).toEqual({ kind: 'onOrigin' });
  });

  it('As a sandbox opened as the top-level page, I report the host so the visitor is sent on', () => {
    // When
    const framing = readSandboxFraming({ href: 'https://myapp.app.dot.li/', framed: false }, BASE_DOMAIN);

    // Then
    expect(framing).toEqual({ kind: 'topLevel', host: 'myapp.app.dot.li' });
  });

  it('As a sandbox handed a href that is no URL, I throw rather than guess an origin', () => {
    // When, Then
    expect(() => readSandboxFraming({ href: 'not a url', framed: true }, BASE_DOMAIN)).toThrow();
  });
});
