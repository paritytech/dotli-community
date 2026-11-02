// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { TopbarState } from './topbarState.js';

/** Returns whether the collapsed capsule leads with the pulsing action dot. Never throws. */
export function isActionNeeded(
  state: Pick<TopbarState, 'visible' | 'blockingModalActive' | 'blockingModalsWaiting'>,
  chatUnread: number,
): boolean {
  return chatUnread > 0 || state.blockingModalsWaiting > 0 || (state.blockingModalActive && !state.visible);
}
