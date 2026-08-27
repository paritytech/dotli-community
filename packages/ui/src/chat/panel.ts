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
  CHAT_BOTS_CHANGED_EVENT,
  CHAT_MESSAGE_EVENT,
  CHAT_ROOMS_CHANGED_EVENT,
  chatBots,
  chatMessages,
  chatRooms,
  userPostMessage,
  userTriggerAction,
  type ChatBotRecord,
  type ChatMessageEventDetail,
  type ChatMessageRecord,
  type ChatRoomRecord,
} from "./service";
import { mountCustomMessage } from "./custom-message";

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
// Runtime productId from `dotli:product-loaded`. The bridge and storage key
// chat data by it, and it can differ from the label-derived id when the
// localhost debug path sets a product-id override.
let currentRuntimeProductId: string | null = null;
let chatAvailable = false;
let open = false;
// null shows the room list; a room id shows that room's conversation.
let activeRoomId: string | null = null;
// Unseen product messages per room; the topbar badge shows the sum.
const unreadByRoom = new Map<string, number>();
let renderQueued = false;
// Bumped per renderPanel run so an older run whose storage reads resolve
// late can detect it was superseded and must not paint over a newer one.
let renderPass = 0;
let timeRefreshTimer: ReturnType<typeof setInterval> | null = null;
// The composer only exists after picking a room, so focus it on that render.
let focusComposerOnRender = false;
// Send-failure notice, kept across re-renders until the next send or edit.
let composerError: string | null = null;
// The core denies every chat call without an active session, so the empty
// state must point at login rather than blame the product.
let loggedIn = false;
// Live custom-message renders in the current message list. Each holds an
// observer and possibly an open product subscription, so every rebuild of
// the list must dispose the previous set before dropping the rows.
let customRenderCleanups: (() => void)[] = [];

function disposeCustomRenders(): void {
  for (const cleanup of customRenderCleanups) {
    cleanup();
  }
  customRenderCleanups = [];
}

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
  if (currentRuntimeProductId !== null) {
    return currentRuntimeProductId;
  }
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

function totalUnread(): number {
  let total = 0;
  for (const count of unreadByRoom.values()) {
    total += count;
  }
  return total;
}

/** "3" / "9+" pill text shared by the topbar badge and the room rows. */
function unreadLabel(count: number): string {
  return count > 9 ? "9+" : String(count);
}

function updateButton(): void {
  if (el === null) {
    return;
  }
  // Every chat call needs an active session, so a logged-out user gets no
  // chat affordance at all rather than a panel full of denied calls.
  const visible = chatAvailable && currentLabel !== null && loggedIn;
  el.button.hidden = !visible;
  el.moreRow.hidden = !visible;
  // While the panel is open the room rows carry their own badges.
  const unreadCount = open ? 0 : totalUnread();
  el.badge.hidden = unreadCount === 0;
  el.badge.textContent = unreadLabel(unreadCount);
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
    case "Actions": {
      if (content.value.text !== undefined && content.value.text !== "") {
        const text = document.createElement("span");
        text.textContent = content.value.text;
        bubble.appendChild(text);
      }
      const actions = document.createElement("div");
      actions.className = `chat-msg-actions chat-msg-actions-${content.value.layout === "Grid" ? "grid" : "column"}`;
      for (const action of content.value.actions) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "chat-custom-btn chat-custom-btn-secondary";
        button.textContent = action.title;
        button.addEventListener("click", () => {
          void userTriggerAction(record.productId, record.roomId, {
            messageId: record.messageId,
            actionId: action.actionId,
          }).catch(() => {
            composerError = "The app could not be reached.";
            scheduleRender();
          });
        });
        actions.appendChild(button);
      }
      bubble.appendChild(actions);
      break;
    }
    case "Custom":
      bubble.className += " chat-msg-custom";
      customRenderCleanups.push(
        mountCustomMessage(bubble, {
          productId: record.productId,
          roomId: record.roomId,
          messageId: record.messageId,
          messageType: content.value.messageType,
          payload: content.value.payload,
        }),
      );
      break;
    default:
      bubble.className += " chat-msg-event";
      bubble.textContent = "[unsupported message]";
  }
  const time = document.createElement("time");
  time.className = "chat-msg-time";
  time.dataset["timestamp"] = String(record.timestamp);
  time.textContent = relativeTime(record.timestamp, Date.now());
  time.title = new Date(record.timestamp).toLocaleString();
  bubble.appendChild(time);
  row.appendChild(bubble);
  return row;
}

// Rewrites the relative bubble timestamps in place. A full re-render just
// for label drift would re-read storage and remount every custom message.
function refreshTimestamps(): void {
  if (el === null) {
    return;
  }
  const now = Date.now();
  for (const time of el.messages.querySelectorAll<HTMLElement>(
    "time.chat-msg-time",
  )) {
    const timestamp = Number(time.dataset["timestamp"]);
    if (Number.isFinite(timestamp)) {
      time.textContent = relativeTime(timestamp, now);
    }
  }
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

/** Circular contact icon; falls back to the name's initial when there is no
 *  usable image. The icon string is product-supplied, so never markup. */
function renderContactIcon(
  name: string,
  icon: string,
  className: string,
): HTMLElement {
  const fallback = (): HTMLElement => {
    const initial = document.createElement("span");
    initial.className = `${className} ${className}-fallback`;
    initial.textContent = (name.trim().charAt(0) || "#").toUpperCase();
    initial.setAttribute("aria-hidden", "true");
    return initial;
  };
  if (icon === "") {
    return fallback();
  }
  const img = document.createElement("img");
  img.className = className;
  img.alt = "";
  img.src = icon;
  img.addEventListener(
    "error",
    () => {
      img.replaceWith(fallback());
    },
    { once: true },
  );
  return img;
}

function renderRoomIcon(room: ChatRoomRecord): HTMLElement {
  return renderContactIcon(room.name, room.icon, "chat-room-icon");
}

/** Avatar + name line above a run of product messages, shown when the
 *  product registered a single bot identity to speak as. */
function renderSenderLine(bot: ChatBotRecord): HTMLElement {
  const line = document.createElement("div");
  line.className = "chat-msg-sender";
  line.appendChild(
    renderContactIcon(bot.name, bot.icon, "chat-msg-sender-icon"),
  );
  const name = document.createElement("span");
  name.className = "chat-msg-sender-name";
  name.textContent = bot.name;
  line.appendChild(name);
  return line;
}

function renderRoomList(rooms: ChatRoomRecord[]): void {
  if (el === null) {
    return;
  }
  el.back.hidden = true;
  el.messages.hidden = true;
  disposeCustomRenders();
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
      const unread = unreadByRoom.get(room.roomId) ?? 0;
      if (unread > 0) {
        const badge = document.createElement("span");
        badge.className = "chat-room-unread";
        badge.textContent = unreadLabel(unread);
        badge.setAttribute(
          "aria-label",
          `${String(unread)} unread message${unread === 1 ? "" : "s"}`,
        );
        row.appendChild(badge);
      }
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
  pass: number,
): Promise<void> {
  if (el === null) {
    return;
  }
  // The conversation is on screen, so its messages count as seen.
  if (unreadByRoom.delete(room.roomId)) {
    updateButton();
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

  const [records, bots] = await Promise.all([
    chatMessages(productId, room.roomId),
    chatBots(productId),
  ]);
  // The active room may have changed while messages loaded, or a newer
  // render may already have painted fresher records.
  if (activeRoomId !== room.roomId || pass !== renderPass) {
    return;
  }
  disposeCustomRenders();
  // Wire messages carry no bot attribution, so each product message is
  // credited to the bot most recently registered when it was posted.
  const senderFor = (timestamp: number): ChatBotRecord | null => {
    let match: ChatBotRecord | null = null;
    for (const bot of bots) {
      if (bot.createdAt <= timestamp) {
        match = bot;
      }
    }
    return match;
  };
  const nodes: HTMLElement[] = [];
  let prevAuthor: ChatMessageRecord["author"] | null = null;
  let prevBotId: string | null = null;
  for (const record of records) {
    if (record.author === "product") {
      const sender = senderFor(record.timestamp);
      if (
        sender !== null &&
        (prevAuthor !== "product" || sender.botId !== prevBotId)
      ) {
        nodes.push(renderSenderLine(sender));
      }
      prevBotId = sender?.botId ?? null;
    }
    nodes.push(renderMessage(record));
    prevAuthor = record.author;
  }
  el.messages.replaceChildren(...nodes);
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
  const pass = ++renderPass;
  el.title.textContent =
    getActiveRootManifest()?.displayName ?? currentLabel ?? "Chat";

  const rooms = await chatRooms(productId);
  if (pass !== renderPass) {
    return;
  }
  if (rooms.length === 0) {
    activeRoomId = null;
    el.back.hidden = true;
    el.rooms.hidden = true;
    el.messages.hidden = true;
    disposeCustomRenders();
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
  await renderConversation(productId, activeRoom, pass);
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
    updateButton();
    scheduleRender();
    timeRefreshTimer ??= setInterval(refreshTimestamps, TIME_REFRESH_MS);
  } else {
    updateButton();
    disposeCustomRenders();
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
    // pointercancel is never followed by pointerup, so both ends of the
    // drag must detach the listeners or they leak and act on later hovers.
    const onEnd = (): void => {
      resize.removeEventListener("pointermove", onMove);
      resize.removeEventListener("pointerup", onEnd);
      resize.removeEventListener("pointercancel", onEnd);
      try {
        localStorage.setItem(PANEL_WIDTH_KEY, String(panel.offsetWidth));
        // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable (private mode); the width just resets next session.
      } catch {
        /* width resets next session */
      }
    };
    resize.addEventListener("pointermove", onMove);
    resize.addEventListener("pointerup", onEnd);
    resize.addEventListener("pointercancel", onEnd);
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
    const { label, productId } = (
      event as CustomEvent<{ label: string; productId?: string }>
    ).detail;
    if (currentLabel !== label) {
      currentLabel = label;
      activeRoomId = null;
      unreadByRoom.clear();
      composerError = null;
    }
    currentRuntimeProductId = productId ?? null;
    updateButton();
    // A product (re)load while the panel is open must refresh its content.
    if (open) {
      scheduleRender();
    }
  });

  window.addEventListener("dotli:product-error", () => {
    currentLabel = null;
    currentRuntimeProductId = null;
    updateButton();
  });

  window.addEventListener("dotli:truapi-auth-state", (event: Event) => {
    const state = (event as CustomEvent<{ tag: string }>).detail;
    // Pairing/Authenticating/LoginFailed are transitional login-flow states,
    // not a session change; acting on them would close an open panel mid-flow.
    if (state.tag !== "Connected" && state.tag !== "Disconnected") {
      return;
    }
    const next = state.tag === "Connected";
    if (next !== loggedIn) {
      loggedIn = next;
      // Login reveals the button at once; logout hides it and closes the panel.
      updateButton();
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
    // A message in the room being viewed is seen immediately; anything
    // else (panel closed, or a different room) counts as unread.
    const viewing = open && activeRoomId === detail.roomId;
    if (detail.author === "product" && !viewing) {
      const count = unreadByRoom.get(detail.roomId) ?? 0;
      unreadByRoom.set(detail.roomId, count + 1);
      updateButton();
    }
    // A message for another room only moves that room's badge; rebuilding
    // the active conversation for it would be wasted storage reads and DOM.
    if (open && (activeRoomId === null || activeRoomId === detail.roomId)) {
      scheduleRender();
    }
  });

  window.addEventListener(CHAT_ROOMS_CHANGED_EVENT, (event: Event) => {
    const detail = (event as CustomEvent<{ productId: string }>).detail;
    if (detail.productId === currentProductId() && open) {
      scheduleRender();
    }
  });

  window.addEventListener(CHAT_BOTS_CHANGED_EVENT, (event: Event) => {
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
