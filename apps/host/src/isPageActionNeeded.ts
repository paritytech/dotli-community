// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { chatPanelState } from './state/chatPanelState.js';
import { isActionNeeded } from './state/isActionNeeded.js';
import { topbarState } from './state/topbarState.js';

/** Returns whether the page waits on the user, a prompt or unread chat, so the capsule leads with the action dot. */
export function isPageActionNeeded(): boolean {
  return isActionNeeded(topbarState.get(), chatPanelState.getTotalUnread(chatPanelState.store.get()));
}
