// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import { createMemo } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { hasLightClient } from '@dotli/config';
import { useStore } from '@dotli/stores-solid';
import { networkMonitorState } from '../network/index.js';
import { settingsState } from '../settings/index.js';
import { getOrbitLayout } from './getOrbitLayout.js';
import { LandingPartIsland } from './LandingPartIsland.js';
import { Orbit } from './Orbit.js';

/** The landing page's orbit backdrop, its inner ring drawn from the light client's peers or the one server. */
export function LandingOrbitIsland(): JSX.Element {
  return (
    <LandingPartIsland>
      <BoundOrbit />
    </LandingPartIsland>
  );
}

// Inside the part, so a failure reading the stores shows the error page as a failure rendering the orbit does.
function BoundOrbit(): JSX.Element {
  const backend = useStore(settingsState.store, settings => settings?.backend ?? null);
  const monitorVersion = useStore(networkMonitorState.version);
  // The monitor seeds its chains from the active network on first read, so it is read only once boot has set the
  // settings. Until then, and in the build render, the light client has no peers.
  const peers = createMemo(() => {
    monitorVersion();
    if (backend() === null) {
      return 0;
    }
    return networkMonitorState.getNetworkStatus().reduce((total, chain) => total + (chain.peers ?? 0), 0);
  });
  const layout = createMemo(() => {
    const current = backend();
    return getOrbitLayout(
      current === null || hasLightClient(current) ? { kind: 'lightClient', peers: peers() } : { kind: 'server' },
    );
  });
  return <Orbit layout={layout()} />;
}
