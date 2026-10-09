// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { LandingPart } from './LandingPart.js';
import { NavForm } from './NavForm.js';

export function LandingNav(): JSX.Element {
  return (
    <LandingPart>
      <NavForm />
    </LandingPart>
  );
}
