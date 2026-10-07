// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { topbarStore } from '../../state/topbar.js';
import { useStore } from '../use-store.js';
import { AuthButton } from './AuthButton.js';
import { ChainsPopover } from './ChainsPopover.js';
// import { ChatButton } from './ChatButton.js';
import { PermissionsPopover } from './PermissionsPopover.js';
import { SettingsPopover } from './SettingsPopover.js';
import { ThemeToggle } from './ThemeToggle.js';
import { ActionGroup } from './topbar/ActionGroup.js';
import { topbarActionRoom, topbarMorph } from '../../topbar-status.js';

/**
 * Island holding the topbar's action group. The account button never collapses into More.
 * Renders nothing on the landing page, which has its own buttons.
 */
export function TopbarActions(): JSX.Element {
  const landing = useStore(topbarStore, state => state.landing);
  return (
    <Show when={!landing()}>
      <ActionGroup room={topbarActionRoom} morph={topbarMorph} end={<AuthButton />}>
        <ChainsPopover />
        {/* Off until the chat button is redone. */}
        {/* <ChatButton /> */}
        <PermissionsPopover />
        <ThemeToggle />
        <SettingsPopover />
      </ActionGroup>
    </Show>
  );
}
