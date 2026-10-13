// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import type { JSX } from '@solidjs/web';
import { NavForm } from '../components/landing/NavForm.js';
import { useActiveTld } from './landing.js';
import { LandingPart } from './LandingPart.js';

/** The landing page's name form, under the visitor's network's TLD. */
export function LandingNav(): JSX.Element {
  return (
    <LandingPart>
      <BoundNavForm />
    </LandingPart>
  );
}

// Inside the part, so a failure binding the form shows the error page as a failure rendering it does.
function BoundNavForm(): JSX.Element {
  const suffix = useActiveTld();
  return <NavForm suffix={suffix} />;
}
