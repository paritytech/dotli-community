// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { isSiteOrigin } from './isSiteOrigin.js';

describe('isSiteOrigin', () => {
  it("As a page of dotli's own on the root or a subdomain over https, I ask the check and am admitted", () => {
    // Given the root and a subdomain over https
    const origins = ['https://dot.li', 'https://browse.dot.li'];

    // When each is checked under dot.li
    const answers = origins.map(origin => isSiteOrigin(origin, 'dot.li', { dev: false }));

    // Then both are admitted
    expect(answers).toEqual([true, true]);
  });

  it('As a product under app., I ask the check and am refused', () => {
    // Given app and a product under it
    const origins = ['https://app.dot.li', 'https://foo.app.dot.li'];

    // When each is checked under dot.li
    const answers = origins.map(origin => isSiteOrigin(origin, 'dot.li', { dev: false }));

    // Then both are refused
    expect(answers).toEqual([false, false]);
  });

  it('As a page on a local root over http, I ask the check and am admitted', () => {
    // Given a local origin over http
    const origin = 'http://localhost:4321';

    // When it is checked with dev off
    const answer = isSiteOrigin(origin, 'dot.li', { dev: false });

    // Then it is admitted
    expect(answer).toBe(true);
  });

  it('As a developer on local.host, I ask the check and am admitted over http only in a development build', () => {
    // Given a local.host origin over http
    const origin = 'http://local.host:4321';

    // When it is checked with dev on and with dev off
    const answers = [true, false].map(dev => isSiteOrigin(origin, 'dot.li', { dev }));

    // Then it is admitted in the development build and refused in the other
    expect(answers).toEqual([true, false]);
  });

  it('As a page off every root or over http off a local root, I ask the check and am refused', () => {
    // Given a foreign origin, the root over http and a string that is no url
    const origins = ['https://evil.example', 'http://dot.li', 'not a url'];

    // When each is checked under dot.li
    const answers = origins.map(origin => isSiteOrigin(origin, 'dot.li', { dev: false }));

    // Then all are refused
    expect(answers).toEqual([false, false, false]);
  });
});
