import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { labelToProductId } from "@dotli/ui/runtime-config";
import { setChatCapability } from "@dotli/shared/chat-capability";
import type { HostChatActionSubscribeItem } from "@parity/truapi";

// The panel and service keep module-level state (listeners, connection
// registry), so each test loads a fresh module instance via resetModules.
async function loadChatModules(): Promise<{
  panel: typeof import("@dotli/ui/chat/panel");
  service: typeof import("@dotli/ui/chat/service");
}> {
  vi.resetModules();
  return {
    panel: await import("@dotli/ui/chat/panel"),
    service: await import("@dotli/ui/chat/service"),
  };
}

function installChatDom(): void {
  document.body.innerHTML = `
    <button id="chat-button" aria-expanded="false" hidden>
      <span id="chat-unread-badge" hidden></span>
    </button>
    <button id="more-row-chat" hidden></button>
    <aside id="chat-panel" hidden>
      <div id="chat-panel-resize"></div>
      <button id="chat-panel-back" hidden></button>
      <span id="chat-panel-title"></span>
      <button id="chat-panel-close"></button>
      <div id="chat-panel-rooms" hidden></div>
      <div id="chat-panel-messages"></div>
      <p id="chat-panel-hint" hidden></p>
      <form id="chat-panel-composer">
        <input id="chat-panel-input" type="text" />
        <button type="submit" id="chat-panel-send"></button>
      </form>
    </aside>
  `;
}

function setLoggedIn(loggedIn: boolean): void {
  window.dispatchEvent(
    new CustomEvent("dotli:truapi-auth-state", {
      detail: { tag: loggedIn ? "Connected" : "Disconnected" },
    }),
  );
}

function loadProduct(label: string): void {
  window.dispatchEvent(
    new CustomEvent("dotli:product-loaded", { detail: { label } }),
  );
  setChatCapability(label, true);
  // The chat affordance is gated on an active session.
  setLoggedIn(true);
}

/** Panel renders on a queued task then reads IndexedDB, so a fixed wait
 *  races slow machines. Poll until the expected state appears. */
async function settle(ready: () => boolean): Promise<void> {
  await vi.waitFor(
    () => {
      if (!ready()) {
        throw new Error("panel has not settled");
      }
    },
    { timeout: 5000 },
  );
}

const byId = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`missing #${id}`);
  }
  return node as T;
};

describe("chat panel", () => {
  beforeEach(() => {
    localStorage.clear();
    installChatDom();
  });

  it("As a user, the chat button appears only for chat-capable products", async () => {
    const { panel } = await loadChatModules();
    panel.initChatPanel();
    const button = byId("chat-button");
    expect(button.hidden).toBe(true);

    loadProduct("chatless");
    setChatCapability("chatless", false);
    expect(button.hidden).toBe(true);

    loadProduct("chatty-visible");
    expect(button.hidden).toBe(false);

    window.dispatchEvent(new CustomEvent("dotli:product-error"));
    expect(button.hidden).toBe(true);
  });

  it("As a user, the chat button is hidden until I log in and hides again on logout", async () => {
    const { panel } = await loadChatModules();
    panel.initChatPanel();
    const button = byId("chat-button");

    loadProduct("chatty-gated");
    setLoggedIn(false);
    expect(button.hidden).toBe(true);

    setLoggedIn(true);
    expect(button.hidden).toBe(false);

    // Logging out while the panel is open must also close it.
    button.click();
    expect(byId("chat-panel").hidden).toBe(false);
    setLoggedIn(false);
    expect(button.hidden).toBe(true);
    expect(byId("chat-panel").hidden).toBe(true);
  });

  it("As a user, an empty room list shows a waiting hint", async () => {
    const { panel } = await loadChatModules();
    panel.initChatPanel();
    loadProduct("chatty-empty");

    byId("chat-button").click();
    await settle(() => !byId("chat-panel-hint").hidden);

    expect(byId("chat-panel").hidden).toBe(false);
    expect(byId("chat-panel-hint").hidden).toBe(false);
    expect(byId<HTMLFormElement>("chat-panel-composer").hidden).toBe(true);
  });

  it("As a user, opening the panel lists rooms with icon and name", async () => {
    const { panel, service } = await loadChatModules();
    panel.initChatPanel();
    loadProduct("chatty-rooms");
    const productId = labelToProductId("chatty-rooms");

    await service.productCreateRoom(productId, {
      roomId: "support",
      name: "Support",
      icon: "data:image/png;base64,AAAA",
    });
    // Room order ties on same-millisecond createdAt stamps; let the clock
    // tick so "General" reliably sorts first (newest created, no messages).
    await new Promise((resolve) => setTimeout(resolve, 2));
    await service.productCreateRoom(productId, {
      roomId: "general",
      name: "General",
      icon: "",
    });

    byId("chat-button").click();
    await settle(
      () => document.querySelectorAll(".chat-room-item").length === 2,
    );

    expect(byId("chat-panel-rooms").hidden).toBe(false);
    expect(byId<HTMLFormElement>("chat-panel-composer").hidden).toBe(true);
    const items =
      document.querySelectorAll<HTMLButtonElement>(".chat-room-item");
    expect(items).toHaveLength(2);
    expect(items[1].textContent).toContain("Support");
    expect(
      items[1].querySelector<HTMLImageElement>("img.chat-room-icon")?.src,
    ).toBe("data:image/png;base64,AAAA");
    // A room without an icon falls back to its initial.
    expect(
      items[0].querySelector(".chat-room-icon-fallback")?.textContent,
    ).toBe("G");

    items[1].click();
    await settle(() => byId("chat-panel-rooms").hidden);
    expect(byId("chat-panel-rooms").hidden).toBe(true);
    expect(byId("chat-panel-title").textContent).toBe("Support");
    expect(byId("chat-panel-back").hidden).toBe(false);
    expect(byId<HTMLFormElement>("chat-panel-composer").hidden).toBe(false);

    byId("chat-panel-back").click();
    await settle(() => !byId("chat-panel-rooms").hidden);
    expect(byId("chat-panel-rooms").hidden).toBe(false);
    expect(byId("chat-panel-back").hidden).toBe(true);
  });

  it("As a user, the panel stretches to the top when the topbar hides", async () => {
    const { panel } = await loadChatModules();
    panel.initChatPanel();
    const panelEl = byId("chat-panel");

    window.dispatchEvent(
      new CustomEvent<boolean>("topbar:visibility", { detail: false }),
    );
    expect(panelEl.classList.contains("topbar-hidden")).toBe(true);

    window.dispatchEvent(
      new CustomEvent<boolean>("topbar:visibility", { detail: true }),
    );
    expect(panelEl.classList.contains("topbar-hidden")).toBe(false);
  });

  it("As a user, product messages render and replies reach the product", async () => {
    const { panel, service } = await loadChatModules();
    panel.initChatPanel();
    loadProduct("chatty-send");
    const productId = labelToProductId("chatty-send");
    const published: HostChatActionSubscribeItem[] = [];
    service.registerChatConnection(productId, {
      publish: async (action) => {
        published.push(action);
      },
      renderCustomMessage: () => () => undefined,
    });

    await service.productCreateRoom(productId, {
      roomId: "main",
      name: "Main",
      icon: "",
    });
    await service.productPostMessage(productId, "main", {
      tag: "Text",
      value: { text: "hello from the app" },
    });

    byId("chat-button").click();
    await settle(() => document.querySelector(".chat-room-item") !== null);
    // The panel opens on the room list; enter the room to see messages.
    const roomItem =
      document.querySelector<HTMLButtonElement>(".chat-room-item");
    expect(roomItem?.textContent).toContain("Main");
    roomItem?.click();
    await settle(
      () =>
        byId("chat-panel-messages").textContent?.includes(
          "hello from the app",
        ) === true,
    );
    expect(byId("chat-panel-messages").textContent).toContain(
      "hello from the app",
    );
    // Bubbles carry a relative timestamp with the exact time on hover.
    const time = document.querySelector<HTMLTimeElement>(".chat-msg-time");
    expect(time?.textContent).toBe("just now");
    expect(time?.title).not.toBe("");

    const input = byId<HTMLInputElement>("chat-panel-input");
    input.value = "hello back";
    byId<HTMLFormElement>("chat-panel-composer").requestSubmit();
    await settle(
      () =>
        byId("chat-panel-messages").textContent?.includes("hello back") ===
          true && published.length === 1,
    );

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      roomId: "main",
      payload: {
        tag: "MessagePosted",
        value: { tag: "Text", value: { text: "hello back" } },
      },
    });
    expect(byId("chat-panel-messages").textContent).toContain("hello back");
  });

  it("As a user, bots and rooms share one list ordered by last message time", async () => {
    const { panel, service } = await loadChatModules();
    panel.initChatPanel();
    loadProduct("contacts");
    const productId = labelToProductId("contacts");

    // Creation and post stamps tie within one millisecond otherwise, and
    // the list orders contacts against those stamps.
    const tick = (): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, 2));
    await service.productCreateRoom(productId, {
      roomId: "first",
      name: "First",
      icon: "",
    });
    await tick();
    await service.productCreateRoom(productId, {
      roomId: "second",
      name: "Second",
      icon: "",
    });
    await tick();
    await service.productCreateRoom(productId, {
      roomId: "idle",
      name: "Idle",
      icon: "",
    });
    await tick();
    expect(
      await service.registerBot(productId, {
        botId: "echo",
        name: "Echo Bot",
        icon: "data:image/png;base64,AAAA",
      }),
    ).toBe("New");
    await tick();
    await service.productPostMessage(productId, "second", {
      tag: "Text",
      value: { text: "older" },
    });
    await tick();
    await service.productPostMessage(productId, "first", {
      tag: "Text",
      value: { text: "newer" },
    });

    byId("chat-button").click();
    await settle(
      () => document.querySelectorAll(".chat-room-item").length === 4,
    );

    // Message-less contacts first (newest created leading), then rooms by
    // last message, newest first.
    const items = [
      ...document.querySelectorAll<HTMLElement>(".chat-room-item"),
    ];
    expect(
      items.map((row) => row.querySelector(".chat-room-name")?.textContent),
    ).toEqual(["Echo Bot", "Idle", "First", "Second"]);

    // The bot renders as an inert contact with its registered icon.
    const botRow = items[0];
    expect(botRow.tagName).toBe("DIV");
    expect(botRow.classList.contains("chat-room-item-bot")).toBe(true);
    expect(
      botRow.querySelector<HTMLImageElement>("img.chat-room-icon")?.src,
    ).toBe("data:image/png;base64,AAAA");
    botRow.click();
    expect(byId("chat-panel-rooms").hidden).toBe(false);

    // Messages carry no sender label above them any more.
    items[2].click();
    await settle(() => byId("chat-panel-rooms").hidden);
    expect(document.querySelector(".chat-msg-sender")).toBeNull();
  });

  it("As a user, custom messages render live trees and taps reach the product", async () => {
    // No IntersectionObserver in this environment: the mount falls back to
    // subscribing immediately, which is exactly what the test needs.
    vi.stubGlobal("IntersectionObserver", undefined);
    try {
      const { panel, service } = await loadChatModules();
      panel.initChatPanel();
      loadProduct("chatty-custom");
      const productId = labelToProductId("chatty-custom");

      const published: HostChatActionSubscribeItem[] = [];
      const renders: {
        request: {
          messageId: string;
          messageType: string;
          payload: Uint8Array;
        };
        sink: {
          onUpdate(node: unknown): void;
          onError?(error: Error): void;
        };
      }[] = [];
      const disposeRender = vi.fn();
      service.registerChatConnection(productId, {
        publish: async (action) => {
          published.push(action);
        },
        renderCustomMessage: (request, sink) => {
          renders.push({ request, sink });
          return disposeRender;
        },
      });

      await service.productCreateRoom(productId, {
        roomId: "main",
        name: "Main",
        icon: "",
      });
      const messageId = await service.productPostMessage(productId, "main", {
        tag: "Custom",
        value: { messageType: "poll", payload: "0x0102" },
      });

      byId("chat-button").click();
      await settle(() => document.querySelector(".chat-room-item") !== null);
      document.querySelector<HTMLButtonElement>(".chat-room-item")?.click();
      await settle(() => renders.length === 1);

      // The cell subscribed with the stored message identity and payload.
      expect(renders).toHaveLength(1);
      expect(renders[0].request.messageId).toBe(messageId);
      expect(renders[0].request.messageType).toBe("poll");
      expect(renders[0].request.payload).toEqual(new Uint8Array([1, 2]));
      expect(byId("chat-panel-messages").textContent).toContain("Loading…");

      // The product streams a tree; the cell replaces its content.
      renders[0].sink.onUpdate({
        tag: "Column",
        value: {
          modifiers: [],
          props: {},
          children: [
            {
              tag: "Text",
              value: {
                modifiers: [],
                props: {},
                children: [{ tag: "String", value: { text: "Pick one" } }],
              },
            },
            {
              tag: "Button",
              value: {
                modifiers: [],
                props: {
                  text: "Option A",
                  enabled: true,
                  loading: undefined,
                  clickAction: "pick:a",
                },
                children: [],
              },
            },
          ],
        },
      });
      expect(byId("chat-panel-messages").textContent).toContain("Pick one");

      // Tapping the rendered button publishes an ActionTriggered action.
      document.querySelector<HTMLButtonElement>(".chat-custom-btn")?.click();
      await settle(() => published.length === 1);
      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({
        roomId: "main",
        peer: "user",
        payload: {
          tag: "ActionTriggered",
          value: { messageId, actionId: "pick:a" },
        },
      });

      // A failed render must not leave a partial tree standing.
      renders[0].sink.onError?.(new Error("render refused"));
      expect(byId("chat-panel-messages").textContent).not.toContain("Pick one");
      expect(byId("chat-panel-messages").textContent).toContain(
        "This message can’t be shown right now.",
      );

      // Leaving the room disposes the live render.
      byId("chat-panel-back").click();
      await settle(() => disposeRender.mock.calls.length > 0);
      expect(disposeRender).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("As a user, unseen product messages show an unread badge", async () => {
    const { panel, service } = await loadChatModules();
    panel.initChatPanel();
    loadProduct("chatty-unread");
    const productId = labelToProductId("chatty-unread");

    await service.productCreateRoom(productId, {
      roomId: "main",
      name: "Main",
      icon: "",
    });
    await service.productPostMessage(productId, "main", {
      tag: "Text",
      value: { text: "ping" },
    });

    const badge = byId("chat-unread-badge");
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe("1");

    byId("chat-button").click();
    await settle(() => badge.hidden);
    expect(badge.hidden).toBe(true);
  });

  it("As a user, each room shows its own unread count until I open it", async () => {
    const { panel, service } = await loadChatModules();
    panel.initChatPanel();
    loadProduct("chatty-room-unread");
    const productId = labelToProductId("chatty-room-unread");

    await service.productCreateRoom(productId, {
      roomId: "busy",
      name: "Busy",
      icon: "",
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await service.productCreateRoom(productId, {
      roomId: "quiet",
      name: "Quiet",
      icon: "",
    });
    await service.productPostMessage(productId, "busy", {
      tag: "Text",
      value: { text: "one" },
    });
    await service.productPostMessage(productId, "busy", {
      tag: "Text",
      value: { text: "two" },
    });

    // The topbar badge sums unreads across rooms.
    const badge = byId("chat-unread-badge");
    expect(badge.textContent).toBe("2");

    byId("chat-button").click();
    await settle(
      () => document.querySelectorAll(".chat-room-item").length === 2,
    );
    const roomBadges = document.querySelectorAll(".chat-room-unread");
    expect(roomBadges).toHaveLength(1);
    expect(roomBadges[0].textContent).toBe("2");
    const busyRow = [
      ...document.querySelectorAll<HTMLButtonElement>(".chat-room-item"),
    ].find((row) => row.textContent?.includes("Busy"));
    expect(busyRow?.querySelector(".chat-room-unread")).not.toBeNull();

    // A message for another room while viewing this one stays unread.
    busyRow?.click();
    await settle(() => byId("chat-panel-rooms").hidden);
    await service.productPostMessage(productId, "quiet", {
      tag: "Text",
      value: { text: "psst" },
    });

    byId("chat-panel-back").click();
    await settle(
      () => document.querySelectorAll(".chat-room-unread").length === 1,
    );
    const backBadges = [
      ...document.querySelectorAll<HTMLButtonElement>(".chat-room-item"),
    ].map((row) => row.querySelector(".chat-room-unread")?.textContent ?? "");
    // Quiet holds the newest message so it lists first, carrying the one
    // unread it accumulated while Busy was on screen.
    expect(backBadges).toEqual(["1", ""]);

    // Closing the panel surfaces the remaining unread on the topbar.
    byId("chat-panel-close").click();
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe("1");
  });
});
