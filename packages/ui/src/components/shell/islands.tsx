// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shell's islands: its reactive pieces, which the host's Astro page
// (apps/host/src/components/Shell.astro) places in the static shell. The
// ones whose first render only matches the build-time render in the browser
// are client-only there (the account button, the auth modal, the URL bar);
// the rest are server-rendered with the page and hydrated.

import type { JSX } from '@solidjs/web';
import { ChainsPopover } from './ChainsPopover.js';
import { ChatButton } from './ChatButton.js';
import { PermissionsPopover } from './PermissionsPopover.js';
import { SettingsPopover } from './SettingsPopover.js';
import { ThemeToggle } from './ThemeToggle.js';
import { TopbarActions } from './topbar/TopbarActions.js';

export { AuthButton } from './AuthButton.js';
export { AuthModal } from './AuthModal.js';
export { LoadingScreen } from './LoadingScreen.js';
export { OfflineBanner } from './OfflineBanner.js';
export { UrlPill } from './UrlPill.js';

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
