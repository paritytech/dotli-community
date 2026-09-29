// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  recordBotsChanged,
  recordMessage,
  recordRoomsChanged,
} from "../../src/state/chat.js";
import {
  CHAT_BOTS_CHANGED_EVENT,
  CHAT_MESSAGE_EVENT,
  CHAT_ROOMS_CHANGED_EVENT,
} from "../../src/chat/service.js";
import { settle } from "../helpers/solid.js";

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

describe("chat events", () => {
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
    rooms.stop();
    bots.stop();
    messages.stop();
  });
});
