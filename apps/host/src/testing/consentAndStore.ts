// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { SiteScreen } from '../runtime/siteSignIn/createSiteRound.js';

/** A round a test drives to its consent and through the window flow. */
type ConsentingRound = {
  /** Resolves once the round shows `view`. Never rejects. */
  waitForView: (view: SiteScreen['view']) => Promise<void>;
  flow: {
    /** Goes on from the consent view. Never rejects. */
    consent: () => Promise<void>;
  };
  /** The window flow the round started says a sign-in is stored. */
  storeSignIn: () => void;
};

/** Consents on the consent view, and the window flow says a sign-in is stored. Never rejects. */
export async function consentAndStore(round: ConsentingRound): Promise<void> {
  await round.waitForView('consent');
  await round.flow.consent();
  round.storeSignIn();
}
