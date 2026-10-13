// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Outside Solid because the eager topbar button and the lazy panel both read it. Rooms, bots and
// messages are not kept here, the open panel follows them in the chat store's view.

import { createSyncStore, shallowEqual, type ReadableStore } from '@dotli/shared';
import {
  subscribeChatCapability,
  chatStore,
  type ChatChange,
  type ChatStore,
  type ChatView,
  labelToProductId,
  getProductState,
  productStore,
  getLoggedIn,
  loggedInStore,
} from '@dotli/host-runtime';
import { getTopbarState, topbarStore } from './topbar.js';

const PANEL_WIDTH_KEY = 'dotli:chat-panel-width';
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 560;
const DEFAULT_PANEL_WIDTH = 360;

export interface ChatPanelState {
  label: string | null;
  /** Differs from the label-derived id when the localhost debug path sets an override. */
  runtimeProductId: string | null;
  available: boolean;
  loggedIn: boolean;
  open: boolean;
  /** null shows the room list. */
  activeRoomId: string | null;
  unreadByRoom: Readonly<Record<string, number>>;
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
  composerError: null,
  focusComposer: false,
  width: DEFAULT_PANEL_WIDTH,
  topbarVisible: true,
};

// A drag past the clamp and repeated availability or topbar events rebuild an equal state.
const panel = createSyncStore<ChatPanelState>('chat_panel', INITIAL, {
  equals: shallowEqual,
});
export const chatPanelStore: ReadableStore<ChatPanelState> = panel;

export function currentChatProductId(state: ChatPanelState = panel.get()): string | null {
  if (state.runtimeProductId !== null) {
    return state.runtimeProductId;
  }
  return state.label === null ? null : labelToProductId(state.label);
}

/** Every chat call needs a session, so a logged-out user gets no chat rather than denied calls. */
export function chatButtonVisible(state: ChatPanelState = panel.get()): boolean {
  return state.available && state.label !== null && state.loggedIn;
}

export function totalChatUnread(state: ChatPanelState = panel.get()): number {
  let total = 0;
  for (const count of Object.values(state.unreadByRoom)) {
    total += count;
  }
  return total;
}

function clampWidth(width: number): number {
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, width));
}

type WidthStorage = () => Pick<Storage, 'getItem' | 'setItem'>;

const pageWidthStorage: WidthStorage = () => localStorage;

// Where the dragged width is kept across sessions, which `initChatPanelState` sets.
let widthStorage = pageWidthStorage;

function storedPanelWidth(): number {
  try {
    const raw = Number(widthStorage().getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(raw) && raw >= MIN_PANEL_WIDTH) {
      return Math.min(raw, MAX_PANEL_WIDTH);
    }
    // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable (private mode); the default width is the safe fallback.
  } catch {
    /* fall through to the default width */
  }
  return DEFAULT_PANEL_WIDTH;
}

function commit(next: ChatPanelState): void {
  panel.set(next.open && !chatButtonVisible(next) ? { ...next, open: false } : next);
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

/** For when the open room no longer exists. */
export function clearActiveChatRoom(): void {
  if (panel.get().activeRoomId !== null) {
    update({ activeRoomId: null });
  }
}

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

/**
 * Marks the followed room seen each time a read of its messages lands. The store only lands a read for the
 * room it still follows, so a read that lands after the panel closed or went back to the list marks nothing.
 */
export function markFollowedRoomSeen(view: ReadableStore<ChatView>): () => void {
  let shown: ChatView['messages'] = null;
  const check = (): void => {
    const { messages, roomId } = view.get();
    if (messages === shown) {
      return;
    }
    shown = messages;
    if (messages !== null && roomId !== null) {
      markChatRoomSeen(roomId);
    }
  };
  check();
  return view.subscribe(check);
}

export function setChatComposerError(message: string | null): void {
  update({ composerError: message });
}

export function consumeComposerFocus(): void {
  if (panel.get().focusComposer) {
    update({ focusComposer: false });
  }
}

export function setChatPanelWidth(width: number): void {
  update({ width: clampWidth(width) });
}

export function persistChatPanelWidth(): void {
  try {
    widthStorage().setItem(PANEL_WIDTH_KEY, String(panel.get().width));
    // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable (private mode); the width just resets next session.
  } catch {
    /* width resets next session */
  }
}

/** `storage` keeps the panel width, reached on every read and write as the page's localStorage can throw. */
export function initChatPanelState(
  chat: Pick<ChatStore, 'subscribe'> = chatStore,
  storage: WidthStorage = pageWidthStorage,
): () => void {
  widthStorage = storage;
  // The label is noted before subscribing, as an answer that already settled calls back at once and re-enters here
  // through the panel's own subscription.
  let capabilityLabel: string | null = null;
  let stopCapability = (): void => undefined;
  const followCapability = (): void => {
    const { label } = panel.get();
    if (label === capabilityLabel) {
      return;
    }
    stopCapability();
    stopCapability = () => undefined;
    capabilityLabel = label;
    if (label !== null) {
      stopCapability = subscribeChatCapability(label, available => {
        update({ available });
      });
    }
  };

  const followProduct = (): void => {
    const product = getProductState();
    if (product.status === 'error') {
      update({ label: null, runtimeProductId: null });
      return;
    }
    if (product.status !== 'loaded') {
      return;
    }
    const { label, productId } = product;
    const state = panel.get();
    const base =
      state.label === label
        ? state
        : {
            ...state,
            label,
            activeRoomId: null,
            unreadByRoom: {},
            composerError: null,
          };
    commit({ ...base, runtimeProductId: productId });
  };

  const onChatChange = (change: ChatChange): void => {
    const state = panel.get();
    if (change.kind !== 'message' || change.author !== 'product' || change.productId !== currentChatProductId(state)) {
      return;
    }
    if (state.open && state.activeRoomId === change.roomId) {
      return;
    }
    update({
      unreadByRoom: {
        ...state.unreadByRoom,
        [change.roomId]: (state.unreadByRoom[change.roomId] ?? 0) + 1,
      },
    });
  };

  const follow = (): void => {
    update({
      loggedIn: getLoggedIn(),
      topbarVisible: getTopbarState().visible,
    });
  };
  follow();
  followProduct();
  followCapability();
  const unsubscribe = [
    loggedInStore.subscribe(follow),
    topbarStore.subscribe(follow),
    productStore.subscribe(followProduct),
    panel.subscribe(followCapability),
    chat.subscribe(onChatChange),
  ];
  return () => {
    for (const stop of unsubscribe) {
      stop();
    }
    stopCapability();
  };
}

export function resetChatPanelStateForTests(): void {
  panel.set(INITIAL);
  widthStorage = pageWidthStorage;
}

// The chat button, a separate island, reads it to tell whether focus was in the panel.
let panelElement: HTMLElement | undefined;

export function getChatPanelElement(): HTMLElement | undefined {
  return panelElement;
}

export function setChatPanelElement(el: HTMLElement): () => void {
  panelElement = el;
  return () => {
    if (panelElement === el) {
      panelElement = undefined;
    }
  };
}
