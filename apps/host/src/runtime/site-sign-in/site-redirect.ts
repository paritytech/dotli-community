// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether the window may answer a redirect sign-in at its return address. Until vetting passes, the address is not
 * trusted, so a failure is only a view and a reason, and nothing goes to the site. Each step runs only once the one
 * before it passed, so a key the browser cannot seal to, or an address of no site, is never fetched.
 */

import { openerParty } from '../session-handoff/opener-rule.js';
import type { RedirectFields } from './site-request.js';
import type { ReturnVerdict } from './site-return.js';

export type RedirectVerdict =
  | { ok: true; origin: string }
  | {
      ok: false;
      view: 'site-not-allowed' | 'site-unsupported' | 'refused';
      reason: 'unsupported_browser' | 'bad_key' | 'return_to_party' | 'return_to_not_listed' | 'well_known_unreachable';
    };

export type RedirectVettingDeps = {
  /** The window's own origin. */
  self: string;
  /** Whether this browser can seal to the site's key. */
  probe: (pub: Uint8Array) => Promise<'ok' | 'unsupported' | 'bad_key'>;
  /** Whether the site's well-known file lists the return address. */
  checkReturnTo: (url: string) => Promise<ReturnVerdict>;
};

/**
 * Vets a redirect sign-in: the browser can seal to the key, the return address is a site's, and the site lists it. A
 * pass names the return address's origin, the one the round answers.
 */
export async function vetRedirect(fields: RedirectFields, deps: RedirectVettingDeps): Promise<RedirectVerdict> {
  const probe = await deps.probe(fields.pub);
  if (probe === 'unsupported') {
    return { ok: false, view: 'site-unsupported', reason: 'unsupported_browser' };
  }
  if (probe === 'bad_key') {
    return { ok: false, view: 'refused', reason: 'bad_key' };
  }
  const { origin } = new URL(fields.returnTo);
  if (openerParty(origin, deps.self).party !== 'third') {
    return { ok: false, view: 'site-not-allowed', reason: 'return_to_party' };
  }
  const listed = await deps.checkReturnTo(fields.returnTo);
  if (!listed.ok) {
    return { ok: false, view: 'site-not-allowed', reason: listed.reason };
  }
  return { ok: true, origin };
}
