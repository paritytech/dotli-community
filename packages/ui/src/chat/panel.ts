// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Docked product-chat panel and its topbar button.
//
// The button appears when the loaded product declares chat in its worker
// manifest (announced via `dotli:chat-availability`). The panel docks to
// the right edge and shrinks the product iframe while open, mirroring the
// debug panel's right dock. Messages render from local storage; sending
// publishes a `MessagePosted` action into the product's core connection.

import { getActiveRootManifest } from "@dotli/shared/active-manifest";
import {
  CHAT_AVAILABILITY_EVENT,
  type ChatAvailabilityDetail,
} from "@dotli/shared/chat-capability";
import type { ChatMessageContent } from "@parity/truapi";
import { labelToProductId } from "../runtime-config";
import {
  CHAT_MESSAGE_EVENT,
  CHAT_ROOMS_CHANGED_EVENT,
  chatMessages,
  chatRooms,
  userPostMessage,
  type ChatMessageEventDetail,
  type ChatMessageRecord,
} from "./service";

const PANEL_WIDTH_KEY = "dotli:chat-panel-width";
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 560;
const DEFAULT_PANEL_WIDTH = 360;

interface PanelElements {
  button: HTMLElement;
  moreRow: HTMLElement;
  badge: HTMLElement;
  panel: HTMLElement;
  resize: HTMLElement;
  title: HTMLElement;
  close: HTMLElement;
  rooms: HTMLElement;
  messages: HTMLElement;
  hint: HTMLElement;
  composer: HTMLFormElement;
  input: HTMLInputElement;
}

let el: PanelElements | null = null;
let currentLabel: string | null = null;
let chatAvailable = false;
let open = false;
let activeRoomId: string | null = null;
let unreadCount = 0;
let renderQueued = false;
// Send-failure notice, kept across re-renders until the next send or edit.
let composerError: string | null = null;

function getElements(): PanelElements | null {
  const button = document.getElementById("chat-button");
  const moreRow = document.getElementById("more-row-chat");
  const badge = document.getElementById("chat-unread-badge");
  const panel = document.getElementById("chat-panel");
  const resize = document.getElementById("chat-panel-resize");
  const title = document.getElementById("chat-panel-title");
  const close = document.getElementById("chat-panel-close");
  const rooms = document.getElementById("chat-panel-rooms");
  const messages = document.getElementById("chat-panel-messages");
  const hint = document.getElementById("chat-panel-hint");
  const composer = document.getElementById("chat-panel-composer");
  const input = document.getElementById("chat-panel-input");
  if (
    button === null ||
    moreRow === null ||
    badge === null ||
    panel === null ||
    resize === null ||
    title === null ||
    close === null ||
    rooms === null ||
    messages === null ||
    hint === null ||
    !(composer instanceof HTMLFormElement) ||
    !(input instanceof HTMLInputElement)
  ) {
    return null;
  }
  return {
    button,
    moreRow,
    badge,
    panel,
    resize,
    title,
    close,
    rooms,
    messages,
    hint,
    composer,
    input,
  };
}

function currentProductId(): string | null {
  return currentLabel === null ? null : labelToProductId(currentLabel);
}

function storedPanelWidth(): number {
  try {
    const raw = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(raw) && raw >= MIN_PANEL_WIDTH) {
      return Math.min(raw, MAX_PANEL_WIDTH);
    }
    // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable (private mode); the default width is the safe fallback.
  } catch {
    /* fall through to the default width */
  }
  return DEFAULT_PANEL_WIDTH;
}

function adjustIframe(): void {
  const iframe = document.querySelector<HTMLIFrameElement>("#app iframe");
  if (iframe === null || el === null) {
    return;
  }
  iframe.style.width = open
    ? `calc(100vw - ${String(el.panel.offsetWidth)}px)`
    : "100%";
}

function updateButton(): void {
  if (el === null) {
    return;
  }
  const visible = chatAvailable && currentLabel !== null;
  el.button.hidden = !visible;
  el.moreRow.hidden = !visible;
  el.badge.hidden = unreadCount === 0;
  el.badge.textContent = unreadCount > 9 ? "9+" : String(unreadCount);
  if (!visible && open) {
    setPanelOpen(false);
  }
}

/** One message row. Built via textContent so product text cannot inject markup. */
function renderMessage(record: ChatMessageRecord): HTMLElement {
  const row = document.createElement("div");
  row.className = `chat-msg ${record.author === "user" ? "chat-msg-user" : "chat-msg-product"}`;
  const bubble = document.createElement("div");
  bubble.className = "chat-msg-bubble";
  const content = record.content as ChatMessageContent;
  switch (content.tag) {
    case "Text":
      bubble.textContent = content.value.text;
      break;
    case "RichText":
      bubble.textContent = content.value.text ?? "";
      if (content.value.media.length > 0) {
        const media = document.createElement("span");
        media.className = "chat-msg-meta";
        media.textContent = ` [${String(content.value.media.length)} attachment${content.value.media.length === 1 ? "" : "s"}]`;
        bubble.appendChild(media);
      }
      break;
    case "Reaction":
      bubble.className += " chat-msg-event";
      bubble.textContent = `reacted ${content.value.emoji}`;
      break;
    case "ReactionRemoved":
      bubble.className += " chat-msg-event";
      bubble.textContent = `removed reaction ${content.value.emoji}`;
      break;
    case "File":
      bubble.textContent = `[file] ${content.value.fileName}`;
      break;
    case "Actions":
      bubble.textContent = content.value.text ?? "[actions]";
      break;
    case "Custom":
      bubble.className += " chat-msg-event";
      bubble.textContent = "[custom message]";
      break;
    default:
      bubble.className += " chat-msg-event";
      bubble.textContent = "[unsupported message]";
  }
  row.appendChild(bubble);
  return row;
}

// Coalesces bursts via setTimeout rather than requestAnimationFrame: rAF
// stalls in hidden tabs, which would wedge the queue flag and drop every
// later render until the next paint.
function scheduleRender(): void {
  if (renderQueued) {
    return;
  }
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    void renderPanel();
  }, 0);
}

async function renderPanel(): Promise<void> {
  if (el === null || !open) {
    return;
  }
  const productId = currentProductId();
  if (productId === null) {
    return;
  }
  el.title.textContent =
    getActiveRootManifest()?.displayName ?? currentLabel ?? "Chat";

  const rooms = await chatRooms(productId);
  if (rooms.length === 0) {
    activeRoomId = null;
    el.rooms.hidden = true;
    el.messages.replaceChildren();
    el.hint.hidden = false;
    el.hint.textContent = "Waiting for the app to start a chat.";
    el.input.disabled = true;
    return;
  }
  if (activeRoomId === null || !rooms.some((r) => r.roomId === activeRoomId)) {
    activeRoomId = rooms[0].roomId;
  }
  el.hint.hidden = composerError === null;
  el.hint.textContent = composerError ?? "";
  el.input.disabled = false;

  el.rooms.hidden = rooms.length < 2;
  if (rooms.length >= 2) {
    el.rooms.replaceChildren(
      ...rooms.map((room) => {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "chat-room-tab";
        tab.setAttribute("role", "tab");
        tab.setAttribute(
          "aria-selected",
          room.roomId === activeRoomId ? "true" : "false",
        );
        tab.textContent = room.name;
        tab.addEventListener("click", () => {
          activeRoomId = room.roomId;
          scheduleRender();
        });
        return tab;
      }),
    );
  }

  const roomId = activeRoomId;
  const records = await chatMessages(productId, roomId);
  // The active room may have changed while messages loaded.
  if (activeRoomId !== roomId) {
    return;
  }
  el.messages.replaceChildren(...records.map(renderMessage));
  el.messages.scrollTop = el.messages.scrollHeight;
}

function setPanelOpen(next: boolean): void {
  if (el === null || open === next) {
    return;
  }
  open = next;
  el.panel.hidden = !next;
  el.button.setAttribute("aria-expanded", next ? "true" : "false");
  el.button.classList.toggle("active", next);
  if (next) {
    el.panel.style.width = `${String(storedPanelWidth())}px`;
    unreadCount = 0;
    updateButton();
    scheduleRender();
    el.input.focus();
  } else {
    updateButton();
  }
  adjustIframe();
}

function initResize(): void {
  if (el === null) {
    return;
  }
  const { resize, panel } = el;
  resize.addEventListener("pointerdown", (down: PointerEvent) => {
    down.preventDefault();
    resize.setPointerCapture(down.pointerId);
    const startX = down.clientX;
    const startWidth = panel.offsetWidth;
    const onMove = (move: PointerEvent): void => {
      const width = Math.min(
        MAX_PANEL_WIDTH,
        Math.max(MIN_PANEL_WIDTH, startWidth + (startX - move.clientX)),
      );
      panel.style.width = `${String(width)}px`;
      adjustIframe();
    };
    const onUp = (): void => {
      resize.removeEventListener("pointermove", onMove);
      resize.removeEventListener("pointerup", onUp);
      try {
        localStorage.setItem(PANEL_WIDTH_KEY, String(panel.offsetWidth));
        // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable (private mode); the width just resets next session.
      } catch {
        /* width resets next session */
      }
    };
    resize.addEventListener("pointermove", onMove);
    resize.addEventListener("pointerup", onUp);
  });
}

async function submitMessage(): Promise<void> {
  if (el === null) {
    return;
  }
  const productId = currentProductId();
  const text = el.input.value.trim();
  if (productId === null || activeRoomId === null || text === "") {
    return;
  }
  el.input.value = "";
  try {
    await userPostMessage(productId, activeRoomId, text);
    composerError = null;
  } catch (error) {
    composerError =
      error instanceof Error && error.message.includes("denied")
        ? "Log in to chat with this app."
        : "Message saved, but the app could not be reached.";
  }
  scheduleRender();
}

/** Wire the chat button + panel. Called once from `initTopBar`. */
export function initChatPanel(): void {
  el = getElements();
  if (el === null) {
    return;
  }

  window.addEventListener(CHAT_AVAILABILITY_EVENT, (event: Event) => {
    const detail = (event as CustomEvent<ChatAvailabilityDetail>).detail;
    if (currentLabel !== null && detail.label !== currentLabel) {
      return;
    }
    chatAvailable = detail.chat;
    updateButton();
  });

  window.addEventListener("dotli:product-loaded", (event: Event) => {
    const { label } = (event as CustomEvent<{ label: string }>).detail;
    if (currentLabel !== label) {
      currentLabel = label;
      activeRoomId = null;
      unreadCount = 0;
      composerError = null;
    }
    updateButton();
    // A product (re)load while the panel is open must refresh its content.
    if (open) {
      scheduleRender();
    }
  });

  window.addEventListener("dotli:product-error", () => {
    currentLabel = null;
    updateButton();
  });

  window.addEventListener(CHAT_MESSAGE_EVENT, (event: Event) => {
    const detail = (event as CustomEvent<ChatMessageEventDetail>).detail;
    if (detail.productId !== currentProductId()) {
      return;
    }
    if (open) {
      scheduleRender();
    } else if (detail.author === "product") {
      unreadCount += 1;
      updateButton();
    }
  });

  window.addEventListener(CHAT_ROOMS_CHANGED_EVENT, (event: Event) => {
    const detail = (event as CustomEvent<{ productId: string }>).detail;
    if (detail.productId === currentProductId() && open) {
      scheduleRender();
    }
  });

  el.button.addEventListener("click", () => {
    setPanelOpen(!open);
  });
  el.close.addEventListener("click", () => {
    setPanelOpen(false);
  });
  el.panel.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      setPanelOpen(false);
      el?.button.focus();
    }
  });
  el.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitMessage();
  });
  initResize();
}
