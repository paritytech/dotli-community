// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import type { JSX } from '@solidjs/web';
import { getOrbitLayout } from './getOrbitLayout.js';
import { LandingPartIsland } from './LandingPartIsland.js';
import { Orbit } from './Orbit.js';

/** The landing page's orbit backdrop. */
export function LandingOrbitIsland(): JSX.Element {
  return (
    <LandingPartIsland>
      <Orbit layout={getOrbitLayout()} />
    </LandingPartIsland>
  );
}
