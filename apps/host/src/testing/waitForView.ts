// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { waitForStatus } from '@dotli/shared';
import type { ReadableAtom } from 'nanostores';
import type { SiteScreen } from '../runtime/siteSignIn/createSiteRound.js';

/** Resolves with the screen once it shows `view`. */
export function waitForView(screen: ReadableAtom<SiteScreen>, view: SiteScreen['view']): Promise<SiteScreen> {
  return waitForStatus(screen, shown => shown.view === view);
}
