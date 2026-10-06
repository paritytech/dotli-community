// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { TopbarState } from './topbar.js';

/**
 * Whether the collapsed capsule leads with the pulsing action dot: chat has
 * unread messages, a prompt waits behind the one on screen, or a prompt is
 * open while the bar is collapsed.
 */
export function needsAction(
  state: Pick<TopbarState, 'visible' | 'blockingModalActive' | 'blockingModalsWaiting'>,
  chatUnread: number,
): boolean {
  return chatUnread > 0 || state.blockingModalsWaiting > 0 || (state.blockingModalActive && !state.visible);
}
