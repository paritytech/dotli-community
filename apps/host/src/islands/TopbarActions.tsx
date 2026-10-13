// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import type { JSX } from '@solidjs/web';
import { LayerTracker, ModalFocusFallback, ReporterContext } from '@dotli/ui';
import { currentProductFrame } from '../product-frame-layout.js';
import { TopbarActions as Actions } from '../components/topbar/TopbarActions.js';
import { registerTopbarSurface } from '../state/topbar-surfaces.js';
import { topbarActionRoom, topbarMorph } from '../topbar-status.js';
import { uiReporter } from '../ui-reporter.js';
import { AccountButton } from './AccountButton.js';
import { NetworkButton } from './NetworkButton.js';
import { PermissionsButton } from './PermissionsButton.js';
import { SettingsButton } from './SettingsButton.js';

/**
 * What the bar gives the surfaces in it: they report through the host's metrics, their popovers and menus keep the
 * auto-hiding bar up while open, and a phone sheet whose trigger left the page hands focus to the product.
 */
export function TopbarProviders(props: { children: JSX.Element }): JSX.Element {
  return (
    <ReporterContext value={uiReporter}>
      <LayerTracker value={registerTopbarSurface}>
        <ModalFocusFallback value={() => currentProductFrame() ?? undefined}>{props.children}</ModalFocusFallback>
      </LayerTracker>
    </ReporterContext>
  );
}

/**
 * The topbar's actions, led by the network button and ending with the account button, sized against the pill's room
 * and waiting out its morphs.
 */
export function TopbarActions(): JSX.Element {
  return (
    <TopbarProviders>
      <Actions
        room={topbarActionRoom}
        morph={topbarMorph}
        network={<NetworkButton />}
        permissions={<PermissionsButton />}
        settings={<SettingsButton />}
        account={<AccountButton />}
      />
    </TopbarProviders>
  );
}
