// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether the window may answer a redirect sign-in at its return address. Until vetting passes, the address is not
 * trusted, so a failure is only a view and a reason, and nothing goes to the site. Each step runs only once the one
 * before it passed, so a key the browser cannot seal to, or an address of no site, is never fetched.
 */

import { getOpenerParty } from '../sessionHandoff/openerRule.js';
import type { RedirectFields } from './readRedirectFields.js';
import type { ReturnVerdict } from './checkReturnTo.js';
import type { SealProbe } from './siteSeal.js';

/** A failed vetting: the view the window shows and the reason it counts. */
type RedirectRefusal = {
  ok: false;
  view: 'site-not-allowed' | 'site-unsupported' | 'refused';
  reason: 'unsupported_browser' | 'bad_key' | 'return_to_party' | Extract<ReturnVerdict, { ok: false }>['reason'];
};

export type RedirectVerdict = { ok: true; origin: string } | RedirectRefusal;

type Params = {
  /** The window's own origin. */
  self: string;
  /** Whether this browser can seal to the site's key. Never rejects. */
  probe: (sitePublicKey: Uint8Array) => Promise<SealProbe>;
  /** Whether the site's well-known file lists the return address. Never rejects. */
  checkReturnTo: (url: string) => Promise<ReturnVerdict>;
};

/**
 * Vets a redirect sign-in: the browser can seal to the key, the return address is a site's, and the site lists it. A
 * pass names the return address's origin, the one the round answers. Never rejects.
 */
export async function vetRedirect(
  { returnTo, sitePublicKey }: RedirectFields,
  { self, probe, checkReturnTo }: Params,
): Promise<RedirectVerdict> {
  const probeRefusal = getProbeRefusal(await probe(sitePublicKey));
  if (probeRefusal !== null) {
    return probeRefusal;
  }
  const { origin } = new URL(returnTo);
  if (getOpenerParty(origin, self).party !== 'third') {
    return { ok: false, view: 'site-not-allowed', reason: 'return_to_party' };
  }
  const listed = await checkReturnTo(returnTo);
  if (!listed.ok) {
    return { ok: false, view: 'site-not-allowed', reason: listed.reason };
  }
  return { ok: true, origin };
}

/** The refusal a probe that did not pass ends the vetting with, or null when the browser can seal to the key. */
function getProbeRefusal(probe: SealProbe): RedirectRefusal | null {
  switch (probe) {
    case 'ok':
      return null;
    case 'unsupported':
      return { ok: false, view: 'site-unsupported', reason: 'unsupported_browser' };
    case 'bad_key':
      return { ok: false, view: 'refused', reason: 'bad_key' };
  }
}
