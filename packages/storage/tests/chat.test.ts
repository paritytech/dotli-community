// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import {
  appendMessage,
  createRoom,
  listBots,
  listMessages,
  listRooms,
  registerBot,
} from "@dotli/storage/chat";

const textContent = (text: string): unknown => ({
  tag: "Text",
  value: { text },
});

describe("chat rooms", () => {
  it("As a product, creating a room reports New then Exists", async () => {
    const room = {
      productId: "roomstatus.dot",
      roomId: "main",
      name: "Main",
      icon: "",
    };

    expect(await createRoom(room)).toBe("New");
    expect(await createRoom(room)).toBe("Exists");
  });

  it("As a host, rooms are scoped per product", async () => {
    await createRoom({ productId: "a.dot", roomId: "r", name: "A", icon: "" });
    await createRoom({ productId: "b.dot", roomId: "r", name: "B", icon: "" });

    const rooms = await listRooms("a.dot");
    expect(rooms).toHaveLength(1);
    expect(rooms[0].name).toBe("A");
  });
});

describe("chat messages", () => {
  it("As a host, messages come back in insertion order per room", async () => {
    const base = {
      productId: "order.dot",
      author: "product" as const,
      timestamp: 1,
    };
    await appendMessage({
      ...base,
      roomId: "main",
      messageId: "m1",
      content: textContent("first"),
    });
    await appendMessage({
      ...base,
      roomId: "other",
      messageId: "m2",
      content: textContent("elsewhere"),
    });
    await appendMessage({
      ...base,
      roomId: "main",
      messageId: "m3",
      author: "user",
      content: textContent("second"),
    });

    const messages = await listMessages("order.dot", "main");
    expect(messages.map((m) => m.messageId)).toEqual(["m1", "m3"]);
    expect(messages[1].author).toBe("user");
  });

  it("As a host, the message list caps at the latest `limit` entries", async () => {
    for (let i = 0; i < 5; i++) {
      await appendMessage({
        productId: "cap.dot",
        roomId: "main",
        messageId: `m${String(i)}`,
        author: "product",
        content: textContent(String(i)),
        timestamp: i,
      });
    }

    const messages = await listMessages("cap.dot", "main", 2);
    expect(messages.map((m) => m.messageId)).toEqual(["m3", "m4"]);
  });
});

describe("chat bots", () => {
  it("As a product, registering a bot reports New then Exists", async () => {
    const bot = {
      productId: "botstatus.dot",
      botId: "echo",
      name: "Echo",
      icon: "",
    };

    expect(await registerBot(bot)).toBe("New");
    expect(await registerBot(bot)).toBe("Exists");
  });

  it("As a product, re-registering refreshes the stored name and icon", async () => {
    await registerBot({
      productId: "refresh.dot",
      botId: "echo",
      name: "Echo",
      icon: "",
    });
    await registerBot({
      productId: "refresh.dot",
      botId: "echo",
      name: "Echo v2",
      icon: "https://example.com/icon.png",
    });

    const bots = await listBots("refresh.dot");
    expect(bots).toHaveLength(1);
    expect(bots[0].name).toBe("Echo v2");
    expect(bots[0].icon).toBe("https://example.com/icon.png");
  });

  it("As a host, bots are scoped per product", async () => {
    await registerBot({ productId: "a.dot", botId: "b", name: "A", icon: "" });
    await registerBot({ productId: "b.dot", botId: "b", name: "B", icon: "" });

    const bots = await listBots("a.dot");
    expect(bots).toHaveLength(1);
    expect(bots[0].name).toBe("A");
  });
});
