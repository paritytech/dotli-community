// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { waitForStatus, type ReadableStore } from '@dotli/shared';
import type { SiteScreen } from '../runtime/siteSignIn/createSiteRound.js';

/** Resolves once `screen` shows `view`. */
export function waitForView(screen: ReadableStore<SiteScreen>, view: SiteScreen['view']): Promise<void> {
  return waitForStatus(screen, shown => shown.view === view);
}
