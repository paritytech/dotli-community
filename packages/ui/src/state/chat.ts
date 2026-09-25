// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  CHAT_AVAILABILITY_EVENT,
  type ChatAvailabilityDetail,
} from "@dotli/shared/chat-capability";
import {
  CHAT_BOTS_CHANGED_EVENT,
  CHAT_MESSAGE_EVENT,
  CHAT_ROOMS_CHANGED_EVENT,
  type ChatMessageEventDetail,
} from "../chat/service";
import { createSyncStore, type ReadableStore } from "./create-store";

export interface ChatState {
  availability: ChatAvailabilityDetail | null;
  roomsVersion: number;
  botsVersion: number;
  lastMessage: ChatMessageEventDetail | null;
}

const chat = createSyncStore<ChatState>({
  availability: null,
  roomsVersion: 0,
  botsVersion: 0,
  lastMessage: null,
});

export const chatStore: ReadableStore<ChatState> = chat;
export const getChatState = chat.get;

function emit(name: string, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

/** Also dispatches `dotli:chat-rooms-changed` with `{ productId }`. */
export function recordRoomsChanged(productId: string): void {
  chat.set({ ...chat.get(), roomsVersion: chat.get().roomsVersion + 1 });
  emit(CHAT_ROOMS_CHANGED_EVENT, { productId });
}

/** Also dispatches `dotli:chat-bots-changed` with `{ productId }`. */
export function recordBotsChanged(productId: string): void {
  chat.set({ ...chat.get(), botsVersion: chat.get().botsVersion + 1 });
  emit(CHAT_BOTS_CHANGED_EVENT, { productId });
}

/** Also dispatches `dotli:chat-message` with the same detail. */
export function recordMessage(detail: ChatMessageEventDetail): void {
  chat.set({ ...chat.get(), lastMessage: detail });
  emit(CHAT_MESSAGE_EVENT, detail);
}

/**
 * Track chat availability. Its producer lives in `@dotli/shared`, which must
 * not import `@dotli/ui`, so the store listens to the event instead of being
 * called. Returns the remove function.
 */
export function initChatStore(): () => void {
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<ChatAvailabilityDetail>).detail;
    chat.set({ ...chat.get(), availability: detail });
  };
  window.addEventListener(CHAT_AVAILABILITY_EVENT, listener);
  return () => {
    window.removeEventListener(CHAT_AVAILABILITY_EVENT, listener);
  };
}
