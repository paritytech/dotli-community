// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { computed, type ReadableAtom } from 'nanostores';
import { chatPanelState } from './state/chatPanelState.js';
import { isActionNeeded } from './state/isActionNeeded.js';
import { topbarState } from './state/topbarState.js';

/** Whether the page waits on the user, a prompt or unread chat. Notifies only when the answer changes. */
export const pageActionNeeded: ReadableAtom<boolean> = computed(
  [topbarState.store, chatPanelState.store],
  (topbar, panel) => isActionNeeded(topbar, chatPanelState.getTotalUnread(panel)),
);
