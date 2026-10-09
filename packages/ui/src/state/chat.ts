// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Chat changes go out as window events for the docked panel, not into a store.

import {
  CHAT_BOTS_CHANGED_EVENT,
  CHAT_MESSAGE_EVENT,
  CHAT_ROOMS_CHANGED_EVENT,
  type ChatMessageEventDetail,
} from '../chat/service.js';

function emit(name: string, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function recordRoomsChanged(productId: string): void {
  emit(CHAT_ROOMS_CHANGED_EVENT, { productId });
}

export function recordBotsChanged(productId: string): void {
  emit(CHAT_BOTS_CHANGED_EVENT, { productId });
}

export function recordMessage(detail: ChatMessageEventDetail): void {
  emit(CHAT_MESSAGE_EVENT, detail);
}
