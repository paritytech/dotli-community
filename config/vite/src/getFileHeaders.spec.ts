// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getFileHeaders } from './getFileHeaders.js';

describe('getFileHeaders', () => {
  it('As a visitor, I load a hashed asset and my browser keeps it for a year without asking again', () => {
    // Given a hashed asset's path
    const pathname = '/assets/index-abc.js';

    // When
    const headers = getFileHeaders(pathname);

    // Then
    expect(headers).toEqual({ 'Cache-Control': 'public, max-age=31536000, immutable' });
  });

  it.each(['/host-sw.js', '/app-sw.js'])(
    'As a visitor, I load the service worker %s and my browser revalidates it and lets it control the whole origin',
    pathname => {
      // Given the row's service worker path

      // When
      const headers = getFileHeaders(pathname);

      // Then
      expect(headers).toEqual({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
    },
  );

  it('As a visitor, I load a page and my browser revalidates it, so a deploy reaches me at once', () => {
    // Given a page's path
    const pathname = '/landing.html';

    // When
    const headers = getFileHeaders(pathname);

    // Then
    expect(headers).toEqual({ 'Cache-Control': 'no-cache' });
  });
});
