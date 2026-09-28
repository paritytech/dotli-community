// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The docked chat panel's contents (components/chat/ChatPanel.tsx) over a
// stand-in chat service, so the tests count storage reads and derivations.
// tests/chat-panel.test.ts covers the panel end to end over IndexedDB.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush } from "solid-js";
import type { RendererNode } from "@parity/truapi";
import type { ChatMessageRecord, ChatRoomRecord } from "@dotli/ui/chat/service";

interface Sink {
  onUpdate: (node: RendererNode) => void;
  onError: (error: unknown) => void;
}

const h = vi.hoisted(() => ({
  rooms: [] as ChatRoomRecord[],
  times: new Map<string, number>(),
  messages: [] as ChatMessageRecord[],
  reads: { contacts: 0, messages: 0 },
  roomsFail: false,
  messagesFail: false,
  sinks: [] as Sink[],
  unreadLabels: 0,
  captured: [] as unknown[],
}));

vi.mock("@dotli/ui/chat/service", async (original) => {
  const actual = await original<typeof import("@dotli/ui/chat/service")>();
  return {
    ...actual,
    chatRooms: vi.fn(async () => {
      h.reads.contacts += 1;
      if (h.roomsFail) {
        throw new Error("IndexedDB is gone");
      }
      return h.rooms.map((room) => ({ ...room }));
    }),
    chatBots: vi.fn(async () => []),
    chatLatestMessageTimes: vi.fn(async () => new Map(h.times)),
    chatMessages: vi.fn(async () => {
      h.reads.messages += 1;
      if (h.messagesFail) {
        throw new Error("IndexedDB is gone");
      }
      return h.messages.map((message) => ({ ...message }));
    }),
    renderCustomMessage: (
      _productId: string,
      _request: unknown,
      sink: Sink,
    ) => {
      h.sinks.push(sink);
      return () => undefined;
    },
  };
});

vi.mock("@dotli/ui/state/chat-panel", async (original) => {
  const actual = await original<typeof import("@dotli/ui/state/chat-panel")>();
  return {
    ...actual,
    chatUnreadLabel: (count: number) => {
      h.unreadLabels += 1;
      return actual.chatUnreadLabel(count);
    },
  };
});

vi.mock("@dotli/metrics/sentry", () => ({
  captureException: (error: unknown) => {
    h.captured.push(error);
  },
}));

import { ChatPanel } from "@dotli/ui/components/chat/ChatPanel";
import {
  backToChatRooms,
  initChatPanelState,
  openChatRoom,
  setChatPanelOpen,
  setChatPanelWidth,
} from "@dotli/ui/state/chat-panel";
import { renderComponent, resetStores, settle } from "../../helpers/solid";

const PRODUCT = "chatty.dot";

/** Let reads resolve and their renders flush. */
async function idle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function emit(name: string, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function message(roomId: string, author: "product" | "user" = "product"): void {
  emit("dotli:chat-message", { productId: PRODUCT, roomId, author });
}

function room(i: number): ChatRoomRecord {
  return {
    productId: PRODUCT,
    roomId: `r${String(i)}`,
    name: `Room ${String(i)}`,
    icon: "",
    createdAt: i,
  } as ChatRoomRecord;
}

function text(seq: number, roomId = "r0"): ChatMessageRecord {
  return {
    seq,
    productId: PRODUCT,
    roomId,
    messageId: `m${String(seq)}`,
    author: "product",
    content: { tag: "Text", value: { text: `t${String(seq)}` } },
    timestamp: 1_700_000_000_000 + seq,
  } as ChatMessageRecord;
}

function custom(seq: number, roomId = "r0"): ChatMessageRecord {
  return {
    ...text(seq, roomId),
    content: { tag: "Custom", value: { messageType: "poll", payload: "0x01" } },
  } as ChatMessageRecord;
}

function rows(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>(".chat-room-item")];
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`missing #${id}`);
  }
  return node as T;
}

let removeRules: (() => void) | undefined;

async function openPanel(roomCount = 20): Promise<void> {
  const container = document.createElement("aside");
  container.id = "chat-panel";
  document.body.append(container);
  removeRules = initChatPanelState();
  emit("dotli:product-loaded", { label: "chatty", productId: PRODUCT });
  emit("dotli:chat-availability", { label: "chatty", chat: true });
  emit("dotli:truapi-auth-state", { tag: "Connected" });
  h.rooms = Array.from({ length: roomCount }, (_, i) => room(i));
  setChatPanelOpen(true);
  renderComponent(() => <ChatPanel />, { container });
  await idle();
}

beforeEach(() => {
  h.rooms = [];
  h.times = new Map();
  h.messages = [];
  h.reads = { contacts: 0, messages: 0 };
  h.roomsFail = false;
  h.messagesFail = false;
  h.sinks = [];
  h.unreadLabels = 0;
  h.captured = [];
});

afterEach(() => {
  removeRules?.();
  removeRules = undefined;
  resetStores();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("chat panel, store slices", () => {
  it("As a user dragging the panel wider, the room rows are not worked out again", async () => {
    // Given: 20 rooms, each with an unread message.
    await openPanel();
    for (let i = 0; i < 20; i++) {
      message(`r${String(i)}`);
    }
    await idle();
    expect(rows()).toHaveLength(20);
    h.unreadLabels = 0;

    // When: 50 pointer moves of a width drag.
    for (let width = 300; width < 350; width++) {
      setChatPanelWidth(width);
      flush();
    }

    // Then
    expect(h.unreadLabels).toBe(0);
  });
});

describe("chat panel, contact reads", () => {
  it("As a user reading a conversation, messages do not re-read the hidden room list", async () => {
    // Given: a room open.
    await openPanel();
    h.messages = [text(1)];
    openChatRoom("r0");
    await idle();
    expect(byId("chat-panel-rooms").hidden).toBe(true);
    const start = { ...h.reads };

    // When: a message in another room, then one in this room.
    message("r5");
    await idle();
    h.messages.push(text(2));
    message("r0");
    await idle();

    // Then: only this room's messages were read again.
    expect(h.reads.contacts - start.contacts).toBe(0);
    expect(h.reads.messages - start.messages).toBe(1);

    // When: back to the list.
    backToChatRooms();
    await idle();

    // Then: the list is read once, for the messages it missed.
    expect(h.reads.contacts - start.contacts).toBe(1);

    // When: a message while the list shows, then opening a room.
    message("r3");
    await idle();
    openChatRoom("r3");
    await idle();

    // Then: one more read for the message, none for opening the room.
    expect(h.reads.contacts - start.contacts).toBe(2);
  });

  it("As a user, going back to a list that missed nothing does not re-read it", async () => {
    // Given
    await openPanel();
    openChatRoom("r0");
    await idle();
    const start = h.reads.contacts;

    // When
    backToChatRooms();
    await idle();

    // Then
    expect(h.reads.contacts).toBe(start);
  });

  it("As a user, a room list that cannot be read says so", async () => {
    // Given
    h.roomsFail = true;

    // When
    await openPanel();

    // Then
    expect(byId("chat-panel-hint").hidden).toBe(false);
    expect(byId("chat-panel-hint").textContent).toBe(
      "Chat could not be loaded.",
    );
    expect(h.captured).toHaveLength(1);
  });

  it("As a user, a conversation that cannot be read says so", async () => {
    // Given
    await openPanel();
    h.messagesFail = true;

    // When
    openChatRoom("r0");
    await idle();

    // Then
    expect(byId("chat-panel-hint").hidden).toBe(false);
    expect(byId("chat-panel-hint").textContent).toBe(
      "Chat could not be loaded.",
    );
    expect(h.captured).toHaveLength(1);
  });
});

describe("chat panel, scrolling", () => {
  /** A messages list of `height()` px in a 200 px viewport. */
  function sized(height: () => number): HTMLElement {
    const list = byId("chat-panel-messages");
    Object.defineProperty(list, "scrollHeight", {
      configurable: true,
      get: height,
    });
    Object.defineProperty(list, "clientHeight", {
      configurable: true,
      get: () => 200,
    });
    return list;
  }

  function scrollTo(list: HTMLElement, top: number): void {
    list.scrollTop = top;
    list.dispatchEvent(new Event("scroll"));
  }

  it("As a user reading older messages, a new message does not pull me down", async () => {
    // Given: a conversation, scrolled up.
    await openPanel(3);
    let height = 1000;
    const list = sized(() => height);
    h.messages = [text(1), text(2)];
    openChatRoom("r0");
    await idle();
    expect(list.scrollTop).toBe(1000);
    scrollTo(list, 100);

    // When
    h.messages.push(text(3));
    height = 1100;
    message("r0");
    await idle();

    // Then
    expect(document.querySelectorAll(".chat-msg")).toHaveLength(3);
    expect(list.scrollTop).toBe(100);
  });

  it("As a user at the newest message, a custom message that renders later stays in view", async () => {
    // Given: a conversation at the bottom, ending with a custom message.
    vi.stubGlobal("IntersectionObserver", undefined);
    await openPanel(3);
    let height = 1000;
    const list = sized(() => height);
    h.messages = [text(1), custom(2)];
    openChatRoom("r0");
    await idle();
    expect(list.scrollTop).toBe(1000);
    scrollTo(list, 800);

    // When: its tree arrives and makes the list taller.
    height = 1300;
    h.sinks[0].onUpdate({
      tag: "Text",
      value: {
        modifiers: [],
        props: {},
        children: [{ tag: "String", value: { text: "Poll" } }],
      },
    });
    await idle();

    // Then
    expect(list.scrollTop).toBe(1300);
  });
});

describe("chat panel, room order", () => {
  it("As a keyboard user on a room row, a message that moves the row keeps my focus on it", async () => {
    // Given: focus on the oldest room, last in the list.
    await openPanel(5);
    const last = rows()[4];
    expect(last.textContent).toContain("Room 0");
    last.focus();

    // When: a message makes that room the most recent.
    h.times = new Map([["r0", 1_800_000_000_000]]);
    message("r0");
    await idle();

    // Then
    expect(rows()[0]).toBe(last);
    expect(document.activeElement).toBe(last);
  });
});
