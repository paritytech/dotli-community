// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { ReturnVerdict } from './checkReturnTo.js';
import type { SealProbe } from './siteSeal.js';
import { vetRedirect } from './vetRedirect.js';

type CreateVettingParams = {
  /** What the seal probe answers, `ok` by default. */
  probe?: SealProbe;
  /** What the well-known check answers, a listed address by default. */
  verdict?: ReturnVerdict;
};

const SELF = 'https://dot.li';
const SITE_PUBLIC_KEY = new Uint8Array(32).fill(5);
const RETURN_TO = 'https://site.example/back?x=1';

/** Vetting ports whose probe and well-known check answer as given, and which record what they were asked. */
function createVetting({ probe = 'ok', verdict = { ok: true } }: CreateVettingParams = {}) {
  const probed: Uint8Array[] = [];
  const checked: string[] = [];
  return {
    probed,
    checked,
    ports: {
      self: SELF,
      probe(sitePublicKey: Uint8Array) {
        probed.push(sitePublicKey);
        return Promise.resolve(probe);
      },
      checkReturnTo(url: string) {
        checked.push(url);
        return Promise.resolve(verdict);
      },
    },
  };
}

describe('redirect vetting', () => {
  it('As a site, I send a listed return address and a good key and the window vets the return address origin', async () => {
    // Given a browser that can seal to the key and a well-known file that lists the address
    const { ports, probed, checked } = createVetting();

    // When the window vets the redirect
    const verdict = await vetRedirect({ returnTo: RETURN_TO, sitePublicKey: SITE_PUBLIC_KEY }, ports);

    // Then it passes with the return address's origin, after probing the key and reading the file
    expect(verdict).toEqual({ ok: true, origin: 'https://site.example' });
    expect(probed).toEqual([SITE_PUBLIC_KEY]);
    expect(checked).toEqual([RETURN_TO]);
  });

  it('As a user of a browser without X25519, I start a redirect sign-in and the window says it cannot finish', async () => {
    // Given a browser that cannot make an X25519 key
    const { ports, checked } = createVetting({ probe: 'unsupported' });

    // When the window vets the redirect
    const verdict = await vetRedirect({ returnTo: RETURN_TO, sitePublicKey: SITE_PUBLIC_KEY }, ports);

    // Then the browser is unsupported and nothing was fetched
    expect(verdict).toEqual({ ok: false, view: 'site-unsupported', reason: 'unsupported_browser' });
    expect(checked).toEqual([]);
  });

  it('As a site, I send a key no secret derives with and the window refuses without fetching', async () => {
    // Given a key the browser cannot derive a secret with
    const { ports, checked } = createVetting({ probe: 'bad_key' });

    // When the window vets the redirect
    const verdict = await vetRedirect({ returnTo: RETURN_TO, sitePublicKey: SITE_PUBLIC_KEY }, ports);

    // Then the refused view shows for a bad key and nothing was fetched
    expect(verdict).toEqual({ ok: false, view: 'refused', reason: 'bad_key' });
    expect(checked).toEqual([]);
  });

  it.each([
    { name: 'a first-party page', returnTo: 'https://browse.dot.li/back' },
    { name: 'the root domain', returnTo: 'https://dot.li/back' },
    { name: 'a sandbox origin', returnTo: 'https://x.app.dot.li/back' },
    { name: 'a sandbox origin with a trailing dot', returnTo: 'https://x.app.dot.li./back' },
    { name: 'an insecure page under the root domain', returnTo: 'http://sub.dot.li/back' },
  ])('As a site, I send a return address on $name and the window refuses it without fetching', async ({ returnTo }) => {
    // Given a return address that is no third party's
    const { ports, checked } = createVetting();

    // When the window vets the redirect
    const verdict = await vetRedirect({ returnTo, sitePublicKey: SITE_PUBLIC_KEY }, ports);

    // Then the site is not allowed for its party and nothing was fetched
    expect(verdict).toEqual({ ok: false, view: 'site-not-allowed', reason: 'return_to_party' });
    expect(checked).toEqual([]);
  });

  it.each(['return_to_not_listed', 'well_known_unreachable'] as const)(
    'As a site whose well-known file does not vouch for the address (%s), I ask to sign in and am not allowed',
    async reason => {
      // Given a well-known check that does not vouch for the address
      const { ports } = createVetting({ verdict: { ok: false, reason } });

      // When the window vets the redirect
      const verdict = await vetRedirect({ returnTo: RETURN_TO, sitePublicKey: SITE_PUBLIC_KEY }, ports);

      // Then the site is not allowed with the check's reason
      expect(verdict).toEqual({ ok: false, view: 'site-not-allowed', reason });
    },
  );
});
