// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { topbarStore } from '../../state/topbar.js';
import { useStore } from '../use-store.js';
import { AuthButton } from './AuthButton.js';
import { ChainsPopover } from './ChainsPopover.js';
import { ChatButton } from './ChatButton.js';
import { PermissionsPopover } from './PermissionsPopover.js';
import { SettingsPopover } from './SettingsPopover.js';
import { ThemeToggle } from './ThemeToggle.js';
import { ActionGroup } from './topbar/ActionGroup.js';

/**
 * The topbar's action group with its items, in bar order: the account
 * button, which never collapses, then the actions the More menu collapses
 * when they do not fit. An island of the host page's top bar (apps/host/src/
 * components/Topbar.astro). Their surfaces render through portals into the
 * body. On the landing page, which has its own account and theme buttons, it
 * renders nothing.
 */
export function TopbarActions(): JSX.Element {
  const landing = useStore(topbarStore, state => state.landing);
  return (
    <Show when={!landing()}>
      <ActionGroup>
        <AuthButton />
        <ChainsPopover />
        <ChatButton />
        <PermissionsPopover />
        <ThemeToggle />
        <SettingsPopover />
      </ActionGroup>
    </Show>
  );
}
