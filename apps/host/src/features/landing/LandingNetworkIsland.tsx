// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import { onSettled } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { networkPause } from '../network/index.js';
import { networkHealthState } from '../network/index.js';
import { networkMonitorState } from '../network/index.js';
import { LandingPartIsland } from './LandingPartIsland.js';
import { NetworkButtonIsland } from '../network/index.js';

/** The landing page's network button, the topbar's, judging the network's health while it shows. */
export function LandingNetworkIsland(): JSX.Element {
  return (
    <LandingPartIsland>
      <BoundNetwork />
    </LandingPartIsland>
  );
}

// The landing page starts no shell state, so the button starts what the topbar's reads from the shell.
function BoundNetwork(): JSX.Element {
  onSettled(() => {
    const stopHealth = networkHealthState.start();
    const stopReturns = networkPause.onReturn(networkMonitorState.recordReturn);
    return () => {
      stopHealth();
      stopReturns();
    };
  });
  return <NetworkButtonIsland />;
}
