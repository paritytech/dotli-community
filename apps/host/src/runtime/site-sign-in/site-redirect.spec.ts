// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { ReturnVerdict } from './site-return.js';
import { vetRedirect } from './site-redirect.js';

const SELF = 'https://dot.li';
const PUB = new Uint8Array(32).fill(5);
const RETURN_TO = 'https://site.example/back?x=1';

type Probe = 'ok' | 'unsupported' | 'bad_key';

/** Vetting deps whose probe and well-known check answer as given, and which record what they were asked. */
function fakeDeps(probe: Probe = 'ok', verdict: ReturnVerdict = { ok: true }) {
  const probed: Uint8Array[] = [];
  const checked: string[] = [];
  return {
    probed,
    checked,
    deps: {
      self: SELF,
      probe: (pub: Uint8Array) => {
        probed.push(pub);
        return Promise.resolve(probe);
      },
      checkReturnTo: (url: string) => {
        checked.push(url);
        return Promise.resolve(verdict);
      },
    },
  };
}

describe('redirect vetting', () => {
  it('As a site, I send a listed return address and a good key and the window vets the return address origin', async () => {
    // Given a browser that can seal to the key and a well-known file that lists the address
    const { deps, probed, checked } = fakeDeps();

    // When the window vets the redirect
    const verdict = await vetRedirect({ returnTo: RETURN_TO, pub: PUB }, deps);

    // Then it passes with the return address's origin, after probing the key and reading the file
    expect(verdict).toEqual({ ok: true, origin: 'https://site.example' });
    expect(probed).toEqual([PUB]);
    expect(checked).toEqual([RETURN_TO]);
  });

  it('As a user of a browser without X25519, I start a redirect sign-in and the window says it cannot finish', async () => {
    // Given a browser that cannot make an X25519 key
    const { deps, checked } = fakeDeps('unsupported');

    // When the window vets the redirect
    const verdict = await vetRedirect({ returnTo: RETURN_TO, pub: PUB }, deps);

    // Then the browser is unsupported and nothing was fetched
    expect(verdict).toEqual({ ok: false, view: 'site-unsupported', reason: 'unsupported_browser' });
    expect(checked).toEqual([]);
  });

  it('As a site, I send a key no secret derives with and the window refuses without fetching', async () => {
    // Given a key the browser cannot derive a secret with
    const { deps, checked } = fakeDeps('bad_key');

    // When the window vets the redirect
    const verdict = await vetRedirect({ returnTo: RETURN_TO, pub: PUB }, deps);

    // Then the refused view shows for a bad key and nothing was fetched
    expect(verdict).toEqual({ ok: false, view: 'refused', reason: 'bad_key' });
    expect(checked).toEqual([]);
  });

  it.each([
    ['a first-party page', 'https://browse.dot.li/back'],
    ['the root domain', 'https://dot.li/back'],
    ['a sandbox origin', 'https://x.app.dot.li/back'],
    ['a sandbox origin with a trailing dot', 'https://x.app.dot.li./back'],
    ['an insecure page under the root domain', 'http://sub.dot.li/back'],
  ])('As a page, I send a return address on %s and the window refuses it without fetching', async (_name, returnTo) => {
    // Given a return address that is no third party's
    const { deps, checked } = fakeDeps();

    // When the window vets the redirect
    const verdict = await vetRedirect({ returnTo, pub: PUB }, deps);

    // Then the site is not allowed for its party and nothing was fetched
    expect(verdict).toEqual({ ok: false, view: 'site-not-allowed', reason: 'return_to_party' });
    expect(checked).toEqual([]);
  });

  it.each(['return_to_not_listed', 'well_known_unreachable'] as const)(
    'As a site whose well-known file does not vouch for the address (%s), I am not allowed',
    async reason => {
      // Given a well-known check that does not vouch for the address
      const { deps } = fakeDeps('ok', { ok: false, reason });

      // When the window vets the redirect
      const verdict = await vetRedirect({ returnTo: RETURN_TO, pub: PUB }, deps);

      // Then the site is not allowed with the check's reason
      expect(verdict).toEqual({ ok: false, view: 'site-not-allowed', reason });
    },
  );
});
