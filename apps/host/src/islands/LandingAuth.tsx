// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import type { JSX } from '@solidjs/web';
import { LandingPart } from './LandingPart.js';
import { AccountButton } from './AccountButton.js';

/**
 * The landing page's account button. It keeps the `landing-` id prefix the end-to-end sign-in addresses. The page is
 * always dark, so it has no theme button.
 */
export function LandingAuth(): JSX.Element {
  return (
    <LandingPart>
      <AccountButton idPrefix="landing-" showName />
    </LandingPart>
  );
}
