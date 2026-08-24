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
  type ChatRoomRecord,
} from "./service";

const PANEL_WIDTH_KEY = "dotli:chat-panel-width";
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 560;
const DEFAULT_PANEL_WIDTH = 360;
// Relative bubble timestamps go stale while the panel sits open.
const TIME_REFRESH_MS = 60_000;

interface PanelElements {
  button: HTMLElement;
  moreRow: HTMLElement;
  badge: HTMLElement;
  panel: HTMLElement;
  resize: HTMLElement;
  title: HTMLElement;
  back: HTMLElement;
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
// null shows the room list; a room id shows that room's conversation.
let activeRoomId: string | null = null;
let unreadCount = 0;
let renderQueued = false;
let timeRefreshTimer: ReturnType<typeof setInterval> | null = null;
// The composer only exists after picking a room, so focus it on that render.
let focusComposerOnRender = false;
// Send-failure notice, kept across re-renders until the next send or edit.
let composerError: string | null = null;
// The core denies every chat call without an active session, so the empty
// state must point at login rather than blame the product.
let loggedIn = false;

function getElements(): PanelElements | null {
  const button = document.getElementById("chat-button");
  const moreRow = document.getElementById("more-row-chat");
  const badge = document.getElementById("chat-unread-badge");
  const panel = document.getElementById("chat-panel");
  const resize = document.getElementById("chat-panel-resize");
  const title = document.getElementById("chat-panel-title");
  const back = document.getElementById("chat-panel-back");
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
    back === null ||
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
    back,
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

/** "just now" / "5 mins ago" / "an hour ago" style label for a bubble. */
function relativeTime(timestamp: number, now: number): string {
  const minutes = Math.floor((now - timestamp) / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return minutes === 1 ? "a min ago" : `${String(minutes)} mins ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? "an hour ago" : `${String(hours)} hours ago`;
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${String(days)} days ago`;
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
  const time = document.createElement("time");
  time.className = "chat-msg-time";
  time.textContent = relativeTime(record.timestamp, Date.now());
  time.title = new Date(record.timestamp).toLocaleString();
  bubble.appendChild(time);
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

/** Circular room icon; falls back to the room's initial when there is no
 *  usable image. The icon string is product-supplied, so never markup. */
function renderRoomIcon(room: ChatRoomRecord): HTMLElement {
  const fallback = (): HTMLElement => {
    const initial = document.createElement("span");
    initial.className = "chat-room-icon chat-room-icon-fallback";
    initial.textContent = (room.name.trim().charAt(0) || "#").toUpperCase();
    initial.setAttribute("aria-hidden", "true");
    return initial;
  };
  if (room.icon === "") {
    return fallback();
  }
  const img = document.createElement("img");
  img.className = "chat-room-icon";
  img.alt = "";
  img.src = room.icon;
  img.addEventListener(
    "error",
    () => {
      img.replaceWith(fallback());
    },
    { once: true },
  );
  return img;
}

function renderRoomList(rooms: ChatRoomRecord[]): void {
  if (el === null) {
    return;
  }
  el.back.hidden = true;
  el.messages.hidden = true;
  el.messages.replaceChildren();
  el.composer.hidden = true;
  el.hint.hidden = true;
  el.rooms.hidden = false;
  el.rooms.replaceChildren(
    ...rooms.map((room) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "chat-room-item";
      row.setAttribute("role", "listitem");
      row.appendChild(renderRoomIcon(room));
      const name = document.createElement("span");
      name.className = "chat-room-name";
      name.textContent = room.name;
      row.appendChild(name);
      row.addEventListener("click", () => {
        activeRoomId = room.roomId;
        focusComposerOnRender = true;
        scheduleRender();
      });
      return row;
    }),
  );
}

async function renderConversation(
  productId: string,
  room: ChatRoomRecord,
): Promise<void> {
  if (el === null) {
    return;
  }
  el.title.textContent = room.name;
  el.back.hidden = false;
  el.rooms.hidden = true;
  el.rooms.replaceChildren();
  el.messages.hidden = false;
  el.composer.hidden = false;
  el.input.disabled = false;
  el.hint.hidden = composerError === null;
  el.hint.textContent = composerError ?? "";

  const records = await chatMessages(productId, room.roomId);
  // The active room may have changed while messages loaded.
  if (activeRoomId !== room.roomId) {
    return;
  }
  el.messages.replaceChildren(...records.map(renderMessage));
  el.messages.scrollTop = el.messages.scrollHeight;
  if (focusComposerOnRender) {
    focusComposerOnRender = false;
    el.input.focus();
  }
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
    el.back.hidden = true;
    el.rooms.hidden = true;
    el.messages.hidden = true;
    el.messages.replaceChildren();
    el.composer.hidden = true;
    el.hint.hidden = false;
    el.hint.textContent = loggedIn
      ? "Waiting for the app to start a chat."
      : "Log in to chat with this app.";
    el.input.disabled = true;
    return;
  }
  const activeRoom = rooms.find((r) => r.roomId === activeRoomId);
  if (activeRoom === undefined) {
    activeRoomId = null;
    renderRoomList(rooms);
    return;
  }
  await renderConversation(productId, activeRoom);
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
    timeRefreshTimer ??= setInterval(scheduleRender, TIME_REFRESH_MS);
  } else {
    updateButton();
    if (timeRefreshTimer !== null) {
      clearInterval(timeRefreshTimer);
      timeRefreshTimer = null;
    }
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

  window.addEventListener("dotli:truapi-auth-state", (event: Event) => {
    const state = (event as CustomEvent<{ tag: string }>).detail;
    const next = state.tag === "Connected";
    if (next !== loggedIn) {
      loggedIn = next;
      if (open) {
        scheduleRender();
      }
    }
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

  // The auto-hidden topbar frees its strip; stretch the panel into it.
  window.addEventListener("topbar:visibility", (event: Event) => {
    const topbarVisible = (event as CustomEvent<boolean>).detail;
    el?.panel.classList.toggle("topbar-hidden", !topbarVisible);
  });

  el.button.addEventListener("click", () => {
    setPanelOpen(!open);
  });
  el.back.addEventListener("click", () => {
    activeRoomId = null;
    composerError = null;
    scheduleRender();
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
