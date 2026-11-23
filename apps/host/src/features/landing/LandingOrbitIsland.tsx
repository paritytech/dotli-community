// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import { createMemo, createSignal, onSettled } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { hasLightClient } from '@dotli/config';
import { isShallowEqual } from '@dotli/shared';
import { useStore } from '@dotli/stores-solid';
import { computed } from 'nanostores';
import { networkMonitorState } from '../network/index.js';
import { settingsState } from '../settings/index.js';
import { anchorOrbitLayout } from './anchorOrbitLayout.js';
import { createLatestLimiter } from './createLatestLimiter.js';
import { followPointer } from './followPointer.js';
import { getOrbitLayout, type OrbitLayout, type OrbitMode } from './getOrbitLayout.js';
import { LandingPartIsland } from './LandingPartIsland.js';
import { Orbit } from './Orbit.js';

/** What the orbit draws until boot sets the settings, the build render included. */
const NO_PEERS: OrbitMode = { kind: 'lightClient', peers: 0 };

// Drawn once per page load, so a dot keeps its place while peers come and go and each visit lays the dots out anew. The
// build render draws no dot, so it reads none of it.
const SEED = Math.random();

// The monitor seeds its chains from the active network on its first read, so it is read only once boot has set the
// settings.
const orbitMode = computed([settingsState.store, networkMonitorState.version], (settings): OrbitMode => {
  if (settings === null) {
    return NO_PEERS;
  }
  if (!hasLightClient(settings.backend)) {
    return { kind: 'trustedProvider' };
  }
  const peers = networkMonitorState.getNetworkStatus().reduce((total, chain) => total + (chain.peers ?? 0), 0);
  return { kind: 'lightClient', peers };
});

/** The landing page's orbit backdrop, its inner ring drawn from the light client's peers or the one trusted provider. */
export function LandingOrbitIsland(): JSX.Element {
  return (
    <LandingPartIsland>
      <BoundOrbit />
    </LandingPartIsland>
  );
}

// Inside the part, so a failure reading the stores shows the error page as a failure rendering the orbit does.
function BoundOrbit(): JSX.Element {
  // The computed builds a new mode on every change the monitor counts, so an equal one keeps the layout.
  const mode = useStore(orbitMode, { initial: NO_PEERS, equals: isShallowEqual });
  // Each layout turns onto the one shown before, so the latest real node that stays keeps its place.
  const layout = createMemo((previous?: OrbitLayout) =>
    anchorOrbitLayout(previous ?? null, getOrbitLayout(mode(), SEED)),
  );
  const [pointer, setPointer] = createSignal({ x: 0, y: 0 });
  onSettled(() => {
    const limiter = createLatestLimiter({
      perSecond: 15,
      onValue: (shift: { x: number; y: number }) => setPointer(shift),
    });
    const stopFollowing = followPointer({ onShift: limiter.push });
    return () => {
      stopFollowing();
      limiter.stop();
    };
  });
  return <Orbit layout={layout()} pointerX={pointer().x} pointerY={pointer().y} />;
}
