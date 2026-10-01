// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The chat service's change announcements, as window events. The docked
// panel (state/chat-panel.ts) listens for them; nothing keeps them in a
// store.

import {
  CHAT_BOTS_CHANGED_EVENT,
  CHAT_MESSAGE_EVENT,
  CHAT_ROOMS_CHANGED_EVENT,
  type ChatMessageEventDetail,
} from '../chat/service.js';

function emit(name: string, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

/** Dispatches `dotli:chat-rooms-changed` with `{ productId }`. */
export function recordRoomsChanged(productId: string): void {
  emit(CHAT_ROOMS_CHANGED_EVENT, { productId });
}

/** Dispatches `dotli:chat-bots-changed` with `{ productId }`. */
export function recordBotsChanged(productId: string): void {
  emit(CHAT_BOTS_CHANGED_EVENT, { productId });
}

/** Dispatches `dotli:chat-message` with the same detail. */
export function recordMessage(detail: ChatMessageEventDetail): void {
  emit(CHAT_MESSAGE_EVENT, detail);
}
