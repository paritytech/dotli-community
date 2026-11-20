// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { getDefaultBackend, hasLightClient } from '@dotli/config';
import { useStore } from '@dotli/stores-solid';
import { isResetRunning, pageSettingsActions, settingsState } from '../settings/index.js';
import { LandingPartIsland } from './LandingPartIsland.js';
import { LightClientInvite } from './LightClientInvite.js';

/**
 * The landing page's invitation to the light client, shown once the visitor's backend is known to run none. The
 * settings are null at build and until boot seeds them, so until then it renders nothing.
 */
export function LandingInviteIsland(): JSX.Element {
  return (
    <LandingPartIsland>
      <BoundInvite />
    </LandingPartIsland>
  );
}

// Inside the part, so a failure reading the stores shows the error page as a failure rendering the invitation does.
function BoundInvite(): JSX.Element {
  const trustedProvider = useStore(
    settingsState.store,
    settings => settings !== null && !hasLightClient(settings.backend),
  );
  const switching = useStore(pageSettingsActions.reset, isResetRunning, { initial: 'idle' });
  return (
    <Show when={trustedProvider()}>
      <LightClientInvite
        switching={switching()}
        onSwitch={() => void pageSettingsActions.switchBackend(getDefaultBackend())}
      />
    </Show>
  );
}
