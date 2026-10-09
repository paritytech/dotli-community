// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { AuthButton } from '../shell/AuthButton.js';
import { LandingPart } from './LandingPart.js';

/**
 * The landing page's account button. It keeps the `landing-` id prefix the end-to-end sign-in addresses. The page is
 * always dark, so it has no theme button.
 */
export function LandingAuth(): JSX.Element {
  return (
    <LandingPart>
      <AuthButton idPrefix="landing-" showName />
    </LandingPart>
  );
}
