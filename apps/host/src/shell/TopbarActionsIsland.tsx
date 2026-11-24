// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import type { JSX } from '@solidjs/web';
import { LayerTracker, ModalFocusFallback, RootBoundary } from '@dotli/ui';
import { productFrameLayout } from '../features/page/index.js';
import { TopbarActions as Actions } from '../features/topbar/index.js';
import { topbarSurfaces } from '../features/page/index.js';
import { topbarMorph } from '../features/topbar/index.js';
import { getTopbarActionRoom } from '../features/topbar/index.js';
import { AccountButtonIsland } from '../features/account/index.js';
import { ChatButtonIsland } from '../features/chat/index.js';
import { NetworkButtonIsland } from '../features/network/index.js';
import { PermissionsButtonIsland } from '../features/permissions/index.js';
import { SettingsButtonIsland } from '../features/settings/index.js';

/**
 * The topbar's actions, led by the network and chat buttons and ending with the account button, sized against the
 * pill's room and waiting out its morphs. Their popovers and menus keep the auto-hiding bar up while open, and a phone
 * sheet whose trigger left the page hands focus to the product.
 */
export function TopbarActionsIsland(): JSX.Element {
  return (
    <RootBoundary root="island:TopbarActions">
      <LayerTracker value={topbarSurfaces.register}>
        <ModalFocusFallback value={productFrameLayout.getFocusFallback}>
          <Actions
            room={getTopbarActionRoom}
            morph={topbarMorph}
            network={<NetworkButtonIsland />}
            chat={<ChatButtonIsland />}
            permissions={<PermissionsButtonIsland />}
            settings={<SettingsButtonIsland />}
            account={<AccountButtonIsland />}
          />
        </ModalFocusFallback>
      </LayerTracker>
    </RootBoundary>
  );
}
