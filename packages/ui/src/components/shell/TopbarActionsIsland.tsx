// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { ChainsPopover } from './ChainsPopover.js';
import { ChatButton } from './ChatButton.js';
import { PermissionsPopover } from './PermissionsPopover.js';
import { SettingsPopover } from './SettingsPopover.js';
import { ThemeToggle } from './ThemeToggle.js';
import { TopbarActions } from './topbar/TopbarActions.js';

/**
 * The topbar's collapsible action group with its items, in bar order. Their
 * surfaces render through portals into the body.
 */
export function TopbarActionsIsland(): JSX.Element {
  return (
    <TopbarActions>
      <ChainsPopover />
      <ChatButton />
      <PermissionsPopover />
      <ThemeToggle />
      <SettingsPopover />
    </TopbarActions>
  );
}
