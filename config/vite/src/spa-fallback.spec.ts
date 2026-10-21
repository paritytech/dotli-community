// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { fallbackFor, type PageRequest } from './spa-fallback.js';

const LANDING = '/landing';

/** A browser page load of `url` on `host`. */
function pageLoad(url: string, host = 'browse.localhost:4321'): PageRequest {
  return { method: 'GET', url, accept: 'text/html,application/xhtml+xml', host };
}

/** A public folder holding `paths`, which records every path a lookup asks for. */
function publicDir(...paths: string[]): { asked: string[]; isPublicFile: (path: string) => boolean } {
  const asked: string[] = [];
  return {
    asked,
    isPublicFile: path => {
      asked.push(path);
      return paths.includes(path);
    },
  };
}

describe('fallbackFor', () => {
  it('As a visitor, I open the bare host and get the landing page with my query kept', () => {
    // Given
    const req = pageLoad('/?ref=x', 'localhost:4321');

    // When
    const action = fallbackFor(req, LANDING, publicDir().isPublicFile);

    // Then
    expect(action).toEqual({ kind: 'rewrite', url: '/landing?ref=x' });
  });

  it('As a visitor, I follow a deep link on a product host and get the shell', () => {
    // Given
    const req = pageLoad('/some/page?tab=2');

    // When
    const action = fallbackFor(req, LANDING, publicDir().isPublicFile);

    // Then
    expect(action).toEqual({ kind: 'rewrite', url: '/?tab=2' });
  });

  it('As a visitor, I open a public file and the dev server serves it', () => {
    // Given
    const files = publicDir('/manifest webmanifest.json');

    // When
    const action = fallbackFor(pageLoad('/manifest%20webmanifest.json'), LANDING, files.isPublicFile);

    // Then
    expect(action).toEqual({ kind: 'pass' });
    expect(files.asked).toEqual(['/manifest webmanifest.json']);
  });

  it('As a page, I fetch a script and the fallback leaves it alone without looking at the disk', () => {
    // Given
    const files = publicDir();
    const req: PageRequest = { method: 'GET', url: '/src/main.ts', accept: '*/*', host: 'browse.localhost:4321' };

    // When
    const action = fallbackFor(req, LANDING, files.isPublicFile);

    // Then
    expect(action).toEqual({ kind: 'pass' });
    expect(files.asked).toEqual([]);
  });

  it('As a visitor, I send a malformed escape and get a 404, not a server error', () => {
    // Given
    const req = pageLoad('/%E0%A4%A');

    // When
    const action = fallbackFor(req, LANDING, publicDir().isPublicFile);

    // Then
    expect(action).toEqual({ kind: 'not-found' });
  });
});
