// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import { untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { chatStore, type ChatStore } from './createChatStore.js';
import { ChatDock as Dock } from './ChatDock.js';
import { useChatDock } from './useChatDock.js';

/**
 * The docked product-chat panel, bound to the page's chat state. Astro hydrates it with no props, so the page's own
 * chat store is the default.
 */
export function ChatDockIsland(props: { chat?: ChatStore }): JSX.Element {
  // Fixed for the island's life.
  const chat = untrack(() => props.chat) ?? chatStore;
  return <Dock {...useChatDock(chat)} />;
}
