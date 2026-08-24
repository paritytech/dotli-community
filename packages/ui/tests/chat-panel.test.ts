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

function loadProduct(label: string): void {
  window.dispatchEvent(
    new CustomEvent("dotli:product-loaded", { detail: { label } }),
  );
  setChatCapability(label, true);
}

/** Panel renders on rAF then reads IndexedDB; settle both. */
async function settle(): Promise<void> {
  await new Promise((resolve) => requestAnimationFrame(resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));
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

  it("As a user, an empty room list shows a waiting hint", async () => {
    const { panel } = await loadChatModules();
    panel.initChatPanel();
    loadProduct("chatty-empty");

    byId("chat-button").click();
    await settle();

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
    await service.productCreateRoom(productId, {
      roomId: "general",
      name: "General",
      icon: "",
    });

    byId("chat-button").click();
    await settle();

    expect(byId("chat-panel-rooms").hidden).toBe(false);
    expect(byId<HTMLFormElement>("chat-panel-composer").hidden).toBe(true);
    const items =
      document.querySelectorAll<HTMLButtonElement>(".chat-room-item");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Support");
    expect(
      items[0].querySelector<HTMLImageElement>("img.chat-room-icon")?.src,
    ).toBe("data:image/png;base64,AAAA");
    // A room without an icon falls back to its initial.
    expect(
      items[1].querySelector(".chat-room-icon-fallback")?.textContent,
    ).toBe("G");

    items[0].click();
    await settle();
    expect(byId("chat-panel-rooms").hidden).toBe(true);
    expect(byId("chat-panel-title").textContent).toBe("Support");
    expect(byId("chat-panel-back").hidden).toBe(false);
    expect(byId<HTMLFormElement>("chat-panel-composer").hidden).toBe(false);

    byId("chat-panel-back").click();
    await settle();
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
    await settle();
    // The panel opens on the room list; enter the room to see messages.
    const roomItem =
      document.querySelector<HTMLButtonElement>(".chat-room-item");
    expect(roomItem?.textContent).toContain("Main");
    roomItem?.click();
    await settle();
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
    await settle();

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
    await settle();
    expect(badge.hidden).toBe(true);
  });
});
