// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Lazy entry points, each its own chunk, so the page boot leaves them out.

import type * as ChatPanelNamespace from './ChatPanel.js';
import type { ChatStore } from './createChatStore.js';

export type ChatPanelModule = typeof ChatPanelNamespace;

/** The chat panel. Rejects when its chunk fails to load. */
export function loadChatPanel(): Promise<ChatPanelModule> {
  return import('./ChatPanel.js');
}

/** The page's chat store, which only a product's chat writes to. Rejects when its chunk fails to load. */
export async function loadChatStore(): Promise<ChatStore> {
  return (await import('./createChatStore.js')).chatStore;
}
