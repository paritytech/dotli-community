// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@solidjs/testing-library";
import type { ChatMessageRecord } from "@dotli/ui/chat/service";

const service = vi.hoisted(() => ({
  userTriggerAction: vi.fn(),
  renderCustomMessage: vi.fn(),
  userTriggerRendererAction: vi.fn(),
}));
vi.mock("@dotli/ui/chat/service", () => service);

import { MessageBubble } from "@dotli/ui/components/chat/MessageBubble";
import { ContactIcon } from "@dotli/ui/components/chat/ContactIcon";
import {
  contactEntries,
  relativeTime,
} from "@dotli/ui/components/chat/contacts";
import { renderComponent, settle } from "../../helpers/solid";

const NOW = 1_700_000_000_000;

function record(
  content: unknown,
  author: "product" | "user" = "product",
): ChatMessageRecord {
  return {
    seq: 1,
    productId: "app.dot",
    roomId: "main",
    messageId: "m1",
    author,
    content,
    timestamp: NOW - 5 * 60_000,
  };
}

async function show(
  content: unknown,
  author: "product" | "user" = "product",
  onActionError = vi.fn(),
): Promise<HTMLElement> {
  const view = renderComponent(() => (
    <MessageBubble
      record={record(content, author)}
      now={NOW}
      onActionError={onActionError}
    />
  ));
  await settle();
  return view.container.querySelector<HTMLElement>(".chat-msg")!;
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("message bubble", () => {
  it("As a user, a text message shows its text and a relative time with the exact time on hover", async () => {
    // When
    const row = await show({
      tag: "Text",
      value: { text: "hello <b>there</b>" },
    });

    // Then
    expect(row.className).toBe("chat-msg chat-msg-product");
    const bubble = row.querySelector(".chat-msg-bubble")!;
    expect(bubble.querySelector("b")).toBeNull();
    expect(bubble.textContent).toContain("hello <b>there</b>");
    const time = bubble.querySelector<HTMLTimeElement>("time.chat-msg-time")!;
    expect(time.textContent).toBe("5 mins ago");
    expect(time.dataset.timestamp).toBe(String(NOW - 5 * 60_000));
    expect(time.title).not.toBe("");
  });

  it("As a user, my own message is styled as mine", async () => {
    // When
    const row = await show({ tag: "Text", value: { text: "me" } }, "user");

    // Then
    expect(row.className).toBe("chat-msg chat-msg-user");
  });

  it("As a user, rich text, reactions, files and unknown messages read as today", async () => {
    // When
    const rich = await show({
      tag: "RichText",
      value: { text: "pics", media: [{}, {}] },
    });

    // Then
    expect(rich.querySelector(".chat-msg-bubble")?.textContent).toContain(
      "pics",
    );
    expect(rich.querySelector(".chat-msg-meta")?.textContent).toBe(
      " [2 attachments]",
    );
    document.body.replaceChildren();

    const reaction = await show({ tag: "Reaction", value: { emoji: "👍" } });
    expect(reaction.querySelector(".chat-msg-bubble")?.className).toBe(
      "chat-msg-bubble chat-msg-event",
    );
    expect(reaction.querySelector(".chat-msg-bubble")?.textContent).toContain(
      "reacted 👍",
    );
    document.body.replaceChildren();

    const removed = await show({
      tag: "ReactionRemoved",
      value: { emoji: "👍" },
    });
    expect(removed.querySelector(".chat-msg-bubble")?.textContent).toContain(
      "removed reaction 👍",
    );
    document.body.replaceChildren();

    const file = await show({ tag: "File", value: { fileName: "a.pdf" } });
    expect(file.querySelector(".chat-msg-bubble")?.textContent).toContain(
      "[file] a.pdf",
    );
    document.body.replaceChildren();

    const unknown = await show({ tag: "Hologram", value: {} });
    expect(unknown.querySelector(".chat-msg-bubble")?.className).toBe(
      "chat-msg-bubble chat-msg-event",
    );
    expect(unknown.querySelector(".chat-msg-bubble")?.textContent).toContain(
      "[unsupported message]",
    );
  });

  it("As a user, action buttons reach the app, and a failure is reported", async () => {
    // Given
    service.userTriggerAction.mockRejectedValueOnce(new Error("offline"));
    const onActionError = vi.fn();
    const row = await show(
      {
        tag: "Actions",
        value: {
          text: "Choose",
          layout: "Grid",
          actions: [
            { actionId: "yes", title: "Yes" },
            { actionId: "no", title: "No" },
          ],
        },
      },
      "product",
      onActionError,
    );

    // Then
    expect(row.querySelector(".chat-msg-actions")?.className).toBe(
      "chat-msg-actions chat-msg-actions-grid",
    );
    const buttons = [
      ...row.querySelectorAll<HTMLButtonElement>(".chat-msg-actions button"),
    ];
    expect(buttons.map((b) => [b.textContent, b.className])).toEqual([
      ["Yes", "chat-custom-btn chat-custom-btn-secondary"],
      ["No", "chat-custom-btn chat-custom-btn-secondary"],
    ]);

    // When
    fireEvent.click(buttons[0]);
    await settle();
    await Promise.resolve();

    // Then
    expect(service.userTriggerAction).toHaveBeenCalledWith("app.dot", "main", {
      messageId: "m1",
      actionId: "yes",
    });
    expect(onActionError).toHaveBeenCalledTimes(1);
  });

  it("As a user, a custom message mounts its live content before the timestamp and stops when removed", async () => {
    // Given
    vi.stubGlobal("IntersectionObserver", undefined);
    const stop = vi.fn();
    service.renderCustomMessage.mockReturnValue(stop);
    const view = renderComponent(() => (
      <MessageBubble
        record={record({
          tag: "Custom",
          value: { messageType: "poll", payload: "0x01" },
        })}
        now={NOW}
        onActionError={vi.fn()}
      />
    ));
    await settle();

    // Then
    const bubble =
      view.container.querySelector<HTMLElement>(".chat-msg-bubble")!;
    expect(bubble.className).toBe("chat-msg-bubble chat-msg-custom");
    expect(bubble.firstElementChild?.className).toBe("chat-custom-root");
    expect(bubble.lastElementChild?.tagName).toBe("TIME");
    expect(service.renderCustomMessage).toHaveBeenCalledTimes(1);

    // When
    view.unmount();

    // Then
    expect(stop).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("As a user, a contact without a usable icon shows its initial", async () => {
    // When
    const view = renderComponent(() => (
      <>
        <ContactIcon name="general" icon="" iconClass="chat-room-icon" />
        <ContactIcon
          name="Support"
          icon="https://example.invalid/x.png"
          iconClass="chat-room-icon"
        />
      </>
    ));
    await settle();

    // Then
    const fallback = view.container.querySelector(".chat-room-icon-fallback")!;
    expect(fallback.textContent).toBe("G");
    expect(fallback.getAttribute("aria-hidden")).toBe("true");
    const img =
      view.container.querySelector<HTMLImageElement>("img.chat-room-icon")!;
    expect(img.alt).toBe("");

    // When: the image fails to load
    fireEvent.error(img);
    await settle();

    // Then
    expect(
      view.container.querySelectorAll(".chat-room-icon-fallback"),
    ).toHaveLength(2);
  });

  it("As a user, a contact whose broken icon the product replaces shows the new icon", async () => {
    // Given: the first icon failed to load.
    const [icon, setIcon] = createSignal("https://example.invalid/old.png");
    const view = renderComponent(() => (
      <ContactIcon name="Support" icon={icon()} iconClass="chat-room-icon" />
    ));
    await settle();
    fireEvent.error(view.container.querySelector("img.chat-room-icon")!);
    await settle();
    expect(view.container.querySelector("img")).toBeNull();

    // When: the product sends a new icon for the room.
    setIcon("https://example.invalid/new.png");
    await settle();

    // Then
    expect(
      view.container.querySelector<HTMLImageElement>("img.chat-room-icon")?.src,
    ).toBe("https://example.invalid/new.png");
    expect(view.container.querySelector(".chat-room-icon-fallback")).toBeNull();
  });

  it("As a user, contacts are ordered by last message, falling back to creation time", () => {
    // When
    const entries = contactEntries(
      [
        { productId: "p", roomId: "old", name: "Old", icon: "", createdAt: 1 },
        { productId: "p", roomId: "new", name: "New", icon: "", createdAt: 5 },
      ],
      [{ productId: "p", botId: "bot", name: "Bot", icon: "", createdAt: 3 }],
      new Map([["old", 10]]),
    );

    // Then
    expect(entries.map((e) => [e.kind, e.id])).toEqual([
      ["room", "old"],
      ["room", "new"],
      ["bot", "bot"],
    ]);
  });

  it("As a user, relative times read naturally", () => {
    expect(relativeTime(NOW, NOW)).toBe("just now");
    expect(relativeTime(NOW - 60_000, NOW)).toBe("a min ago");
    expect(relativeTime(NOW - 3 * 60_000, NOW)).toBe("3 mins ago");
    expect(relativeTime(NOW - 60 * 60_000, NOW)).toBe("an hour ago");
    expect(relativeTime(NOW - 5 * 60 * 60_000, NOW)).toBe("5 hours ago");
    expect(relativeTime(NOW - 24 * 60 * 60_000, NOW)).toBe("yesterday");
    expect(relativeTime(NOW - 3 * 24 * 60 * 60_000, NOW)).toBe("3 days ago");
  });
});
