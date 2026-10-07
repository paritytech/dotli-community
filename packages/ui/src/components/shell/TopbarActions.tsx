// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { AuthButton } from './AuthButton.js';
import { ChainsPopover } from './ChainsPopover.js';
// import { ChatButton } from './ChatButton.js';
import { PermissionsPopover } from './PermissionsPopover.js';
import { SettingsPopover } from './SettingsPopover.js';
import { ThemeToggle } from './ThemeToggle.js';
import { ActionGroup } from './topbar/ActionGroup.js';
import { topbarActionRoom, topbarMorph } from '../../topbar-status.js';

/** Island holding the topbar's action group. The account button never collapses into More. */
export function TopbarActions(): JSX.Element {
  return (
    <ActionGroup room={topbarActionRoom} morph={topbarMorph} end={<AuthButton />}>
      <ChainsPopover />
      {/* Off until the chat button is redone. */}
      {/* <ChatButton /> */}
      <PermissionsPopover />
      <ThemeToggle />
      <SettingsPopover />
    </ActionGroup>
  );
}
