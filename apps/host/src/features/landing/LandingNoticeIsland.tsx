// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { NETWORK_NAME_TO_SERVICES_CONFIG, type Network } from '@dotli/config';
import { useStore } from '@dotli/stores-solid';
import { settingsState } from '../settings/index.js';
import { LandingPartIsland } from './LandingPartIsland.js';

type Networks = Readonly<Record<Network, Pick<(typeof NETWORK_NAME_TO_SERVICES_CONFIG)[Network], 'testnet'>>>;

type Props = {
  /** What each network says about itself, the network table by default. */
  networks?: Networks;
};

/**
 * The landing footer's test network notice, filled in once the visitor's network is known to be a test network. The
 * settings are null at build and until boot seeds them, so until then it renders nothing.
 */
export function LandingNoticeIsland(props: Props): JSX.Element {
  return (
    <LandingPartIsland>
      <BoundNotice networks={props.networks ?? NETWORK_NAME_TO_SERVICES_CONFIG} />
    </LandingPartIsland>
  );
}

// Inside the part, so a failure reading the settings shows the error page as a failure rendering the notice does.
function BoundNotice(props: { networks: Networks }): JSX.Element {
  const testnet = useStore(
    settingsState.store,
    settings => settings !== null && props.networks[settings.network].testnet,
  );
  return <Show when={testnet()}>Test network · tokens have no real value</Show>;
}
