// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from "vitest";
import {
  chatState,
  getChatState,
  initChatStore,
  recordBotsChanged,
  recordMessage,
  recordRoomsChanged,
} from "@dotli/ui/state/chat";
import {
  CHAT_BOTS_CHANGED_EVENT,
  CHAT_MESSAGE_EVENT,
  CHAT_ROOMS_CHANGED_EVENT,
} from "@dotli/ui/chat/service";
import { CHAT_AVAILABILITY_EVENT } from "@dotli/shared/chat-capability";
import { resetStores, settle } from "../helpers/solid";

function capture(name: string): { details: unknown[]; stop: () => void } {
  const details: unknown[] = [];
  const listener = (e: Event): void => {
    details.push((e as CustomEvent).detail);
  };
  window.addEventListener(name, listener);
  return {
    details,
    stop: () => {
      window.removeEventListener(name, listener);
    },
  };
}

describe("chat store", () => {
  afterEach(() => {
    resetStores();
  });

  it("As the chat panel, the store starts empty", () => {
    expect(getChatState()).toEqual({
      availability: null,
      roomsVersion: 0,
      botsVersion: 0,
      lastMessage: null,
    });
  });

  it("As a chat listener, rooms, bots and message changes keep their event names and details", async () => {
    // Given
    const rooms = capture(CHAT_ROOMS_CHANGED_EVENT);
    const bots = capture(CHAT_BOTS_CHANGED_EVENT);
    const messages = capture(CHAT_MESSAGE_EVENT);
    const msg = { productId: "p", roomId: "r", author: "user" as const };

    // When
    recordRoomsChanged("p");
    recordBotsChanged("p");
    recordMessage(msg);
    await settle();

    // Then
    expect(rooms.details).toEqual([{ productId: "p" }]);
    expect(bots.details).toEqual([{ productId: "p" }]);
    expect(messages.details).toEqual([msg]);
    expect(chatState()).toMatchObject({
      roomsVersion: 1,
      botsVersion: 1,
      lastMessage: msg,
    });
    rooms.stop();
    bots.stop();
    messages.stop();
  });

  it("As the chat panel, availability announced by @dotli/shared lands in the store once initChatStore runs", () => {
    // Given
    const stop = initChatStore();

    // When
    window.dispatchEvent(
      new CustomEvent(CHAT_AVAILABILITY_EVENT, {
        detail: { label: "myapp", chat: true },
      }),
    );

    // Then
    expect(getChatState().availability).toEqual({ label: "myapp", chat: true });
    stop();
  });

  it("As the host, stopping the chat store stops tracking availability", () => {
    // Given
    const stop = initChatStore();
    stop();

    // When
    window.dispatchEvent(
      new CustomEvent(CHAT_AVAILABILITY_EVENT, {
        detail: { label: "other", chat: false },
      }),
    );

    // Then
    expect(getChatState().availability).toBeNull();
  });
});
