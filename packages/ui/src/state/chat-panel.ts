// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// State of the docked chat panel and the rules that change it, outside
// Solid: the topbar button (eager) and the lazily loaded panel components
// both read it. Rooms, bots and messages are not cached here; the panel
// re-reads them from storage when `contactsVersion` or a room's `roomSeq`
// moves.

import {
  CHAT_AVAILABILITY_EVENT,
  type ChatAvailabilityDetail,
} from "@dotli/shared/chat-capability";
import {
  CHAT_BOTS_CHANGED_EVENT,
  CHAT_MESSAGE_EVENT,
  CHAT_ROOMS_CHANGED_EVENT,
  type ChatMessageEventDetail,
} from "../chat/service";
import { labelToProductId } from "../runtime-config";
import { createSyncStore, type ReadableStore } from "./create-store";

export const PANEL_WIDTH_KEY = "dotli:chat-panel-width";
export const MIN_PANEL_WIDTH = 280;
export const MAX_PANEL_WIDTH = 560;
export const DEFAULT_PANEL_WIDTH = 360;

export interface ChatPanelState {
  label: string | null;
  /**
   * Runtime productId from `dotli:product-loaded`. It can differ from the
   * label-derived id when the localhost debug path sets an override.
   */
  runtimeProductId: string | null;
  available: boolean;
  loggedIn: boolean;
  open: boolean;
  /** null shows the room list. */
  activeRoomId: string | null;
  unreadByRoom: Readonly<Record<string, number>>;
  /** Messages seen per room since the product loaded; moves on every message. */
  roomSeq: Readonly<Record<string, number>>;
  /** Moves whenever the contact list may have changed. */
  contactsVersion: number;
  composerError: string | null;
  /** One-shot: focus the composer after picking a room. */
  focusComposer: boolean;
  width: number;
  topbarVisible: boolean;
}

const INITIAL: ChatPanelState = {
  label: null,
  runtimeProductId: null,
  available: false,
  loggedIn: false,
  open: false,
  activeRoomId: null,
  unreadByRoom: {},
  roomSeq: {},
  contactsVersion: 0,
  composerError: null,
  focusComposer: false,
  width: DEFAULT_PANEL_WIDTH,
  topbarVisible: true,
};

const panel = createSyncStore<ChatPanelState>(INITIAL);
export const chatPanelStore: ReadableStore<ChatPanelState> = panel;

export function currentChatProductId(
  state: ChatPanelState = panel.get(),
): string | null {
  if (state.runtimeProductId !== null) {
    return state.runtimeProductId;
  }
  return state.label === null ? null : labelToProductId(state.label);
}

/**
 * Every chat call needs an active session, so a logged-out user gets no chat
 * affordance at all rather than a panel full of denied calls.
 */
export function chatButtonVisible(
  state: ChatPanelState = panel.get(),
): boolean {
  return state.available && state.label !== null && state.loggedIn;
}

export function totalChatUnread(state: ChatPanelState = panel.get()): number {
  let total = 0;
  for (const count of Object.values(state.unreadByRoom)) {
    total += count;
  }
  return total;
}

/** "3" / "9+" pill text shared by the topbar badge and the room rows. */
export function chatUnreadLabel(count: number): string {
  return count > 9 ? "9+" : String(count);
}

function clampWidth(width: number): number {
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, width));
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

/** Write, closing the panel if the button just became invisible. */
function commit(next: ChatPanelState): void {
  panel.set(
    next.open && !chatButtonVisible(next) ? { ...next, open: false } : next,
  );
}

function update(patch: Partial<ChatPanelState>): void {
  commit({ ...panel.get(), ...patch });
}

export function setChatPanelOpen(open: boolean): void {
  const state = panel.get();
  if (state.open === open) {
    return;
  }
  update(open ? { open, width: storedPanelWidth() } : { open });
}

export function openChatRoom(roomId: string): void {
  update({ activeRoomId: roomId, focusComposer: true });
}

export function backToChatRooms(): void {
  update({ activeRoomId: null, composerError: null });
}

/** The open room no longer exists (or there are no contacts). */
export function clearActiveChatRoom(): void {
  if (panel.get().activeRoomId !== null) {
    update({ activeRoomId: null });
  }
}

/** The room's conversation is on screen, so its messages count as seen. */
export function markChatRoomSeen(roomId: string): void {
  const { unreadByRoom } = panel.get();
  if (!(roomId in unreadByRoom)) {
    return;
  }
  const rest = { ...unreadByRoom };
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- shallow immutable copy of the unread record, removing one entry.
  delete rest[roomId];
  update({ unreadByRoom: rest });
}

export function setChatComposerError(message: string | null): void {
  update({ composerError: message });
}

export function consumeComposerFocus(): void {
  if (panel.get().focusComposer) {
    update({ focusComposer: false });
  }
}

/** Live resize; clamped to 280–560 px. */
export function setChatPanelWidth(width: number): void {
  update({ width: clampWidth(width) });
}

export function persistChatPanelWidth(): void {
  try {
    localStorage.setItem(PANEL_WIDTH_KEY, String(panel.get().width));
    // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable (private mode); the width just resets next session.
  } catch {
    /* width resets next session */
  }
}

/** Install today's window-event rules. Returns the remove function. */
export function initChatPanelState(): () => void {
  const onAvailability = (event: Event): void => {
    const detail = (event as CustomEvent<ChatAvailabilityDetail>).detail;
    const state = panel.get();
    if (state.label !== null && detail.label !== state.label) {
      return;
    }
    commit({ ...state, available: detail.chat });
  };

  const onProductLoaded = (event: Event): void => {
    const { label, productId } = (
      event as CustomEvent<{ label: string; productId?: string }>
    ).detail;
    const state = panel.get();
    const base =
      state.label === label
        ? state
        : {
            ...state,
            label,
            activeRoomId: null,
            unreadByRoom: {},
            roomSeq: {},
            composerError: null,
          };
    // A product (re)load while the panel is open must refresh its content.
    commit({
      ...base,
      runtimeProductId: productId ?? null,
      contactsVersion: base.contactsVersion + 1,
    });
  };

  const onProductError = (): void => {
    update({ label: null, runtimeProductId: null });
  };

  const onAuthState = (event: Event): void => {
    const { tag } = (event as CustomEvent<{ tag: string }>).detail;
    // Pairing/Authenticating/LoginFailed are transitional login-flow states,
    // not a session change; acting on them would close an open panel mid-flow.
    if (tag !== "Connected" && tag !== "Disconnected") {
      return;
    }
    const loggedIn = tag === "Connected";
    if (panel.get().loggedIn !== loggedIn) {
      update({ loggedIn });
    }
  };

  const onMessage = (event: Event): void => {
    const detail = (event as CustomEvent<ChatMessageEventDetail>).detail;
    const state = panel.get();
    if (detail.productId !== currentChatProductId(state)) {
      return;
    }
    // A message in the room being viewed is seen immediately; anything else
    // (panel closed, or a different room) counts as unread.
    const viewing = state.open && state.activeRoomId === detail.roomId;
    const unreadByRoom =
      detail.author === "product" && !viewing
        ? {
            ...state.unreadByRoom,
            [detail.roomId]: (state.unreadByRoom[detail.roomId] ?? 0) + 1,
          }
        : state.unreadByRoom;
    commit({
      ...state,
      unreadByRoom,
      roomSeq: {
        ...state.roomSeq,
        [detail.roomId]: (state.roomSeq[detail.roomId] ?? 0) + 1,
      },
      contactsVersion: state.contactsVersion + 1,
    });
  };

  const onContactsChanged = (event: Event): void => {
    const { productId } = (event as CustomEvent<{ productId: string }>).detail;
    const state = panel.get();
    if (productId === currentChatProductId(state)) {
      commit({ ...state, contactsVersion: state.contactsVersion + 1 });
    }
  };

  const onTopbarVisibility = (event: Event): void => {
    update({ topbarVisible: (event as CustomEvent<boolean>).detail });
  };

  const listeners: [string, (event: Event) => void][] = [
    [CHAT_AVAILABILITY_EVENT, onAvailability],
    ["dotli:product-loaded", onProductLoaded],
    ["dotli:product-error", onProductError],
    ["dotli:truapi-auth-state", onAuthState],
    [CHAT_MESSAGE_EVENT, onMessage],
    [CHAT_ROOMS_CHANGED_EVENT, onContactsChanged],
    [CHAT_BOTS_CHANGED_EVENT, onContactsChanged],
    ["topbar:visibility", onTopbarVisibility],
  ];
  for (const [name, listener] of listeners) {
    window.addEventListener(name, listener);
  }
  return () => {
    for (const [name, listener] of listeners) {
      window.removeEventListener(name, listener);
    }
  };
}

/** Tests only. */
export function resetChatPanelStateForTests(): void {
  panel.set(INITIAL);
}
