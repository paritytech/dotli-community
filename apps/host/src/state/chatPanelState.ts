// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Outside Solid, since islands that hydrate apart read it. It keeps no rooms, bots or messages.

import {
  createSharedRun,
  createSyncStore,
  pageLocalStorage,
  registerStoreStateReset,
  isShallowEqual,
  type ReadableStore,
  type SafeStorage,
} from '@dotli/shared';
import { chatStore, type ChatChange, type ChatStore, type ChatView } from '../runtime/chat/createChatStore.js';
import { toProductId } from '../runtime/createTruapiRuntimeConfig.js';
import { productState } from '../runtime/state/productState.js';
import { authState } from '../runtime/state/authState.js';
import { topbarState } from './topbarState.js';

export type ChatPanelState = {
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
};

type WidthStorage = Pick<SafeStorage, 'getItem' | 'setItem'>;

type Params = {
  /** The chat store whose product messages count as unread, the page's by default. */
  chat?: Pick<ChatStore, 'subscribe'>;
  /** Keeps the dragged panel width across sessions, the page's local storage by default. */
  storage?: WidthStorage;
};

const PANEL_WIDTH_KEY = 'dotli:chat-panel-width';
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 560;
const DEFAULT_PANEL_WIDTH = 360;

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

// A drag past the clamp and repeated product or topbar events rebuild an equal state.
const panel = createSyncStore<ChatPanelState>({
  name: 'chat_panel',
  initial: INITIAL,
  equals: isShallowEqual,
});
const store: ReadableStore<ChatPanelState> = panel;

let widthStorage: WidthStorage = pageLocalStorage;

// The panel hydrates as an island of its own, so its element is handed over here, not passed in.
let panelElement: HTMLElement | undefined;

// A second subscription would count each product message twice as unread.
const run = createSharedRun<Required<Params>>({ begin: beginFollowing });

/** What the chat panel and its button show. */
export const chatPanelState = {
  /** What the panel and its button show. Notifies only when a field changes. */
  store,
  /** Returns the product whose chat `state` shows, or null when no product is on show. Never throws. */
  getCurrentProductId,
  /** Returns whether `state` shows the chat button. Never throws. */
  isButtonVisible,
  /** Returns the unread count summed over every room of `state`. Never throws. */
  getTotalUnread,
  /** Opens the panel at its stored width, or closes it. The panel stays closed while the button is hidden. Never throws. */
  setOpen,
  /** Shows the room `roomId` and focuses its composer. Never throws. */
  openRoom,
  /** Shows the room list and clears the composer error. Never throws. */
  backToRooms,
  /** Shows the room list in place of a room that no longer exists. Never throws. */
  clearActiveRoom,
  /** Clears the unread count of the room `roomId`. Never throws. */
  markRoomSeen,
  /**
   * Marks the room `view` follows seen each time a read of its messages lands, until the returned stop. Only a read
   * that `view` shows marks a room, so one for a room it no longer follows marks nothing. Never throws.
   */
  markFollowedRoomSeen,
  /** Shows `message` as the composer's error, or clears it with null. Never throws. */
  setComposerError,
  /** Clears the one-shot request to focus the composer. Never throws. */
  consumeComposerFocus,
  /** Sets the panel width, clamped to the allowed range. Never throws. */
  setWidth,
  /** Stores the panel's width for later sessions. Never throws. */
  persistWidth,
  /**
   * Follows the session, the topbar, the product on show and its chat messages until the returned stop. A call while
   * the follows run joins them and ignores its params, and they end with the last caller's stop. Never throws.
   */
  start,
  /** Returns the panel's element, or undefined when none is handed over. Never throws. */
  getElement,
  /**
   * Hands over the panel's element. Returns a release that clears it, unless another element was handed over since.
   * Never throws.
   */
  setElement,
};

// The store resets itself. The width storage beside it goes back to the page's, the follows end and the element is
// let go.
registerStoreStateReset(() => {
  widthStorage = pageLocalStorage;
  run.end();
  panelElement = undefined;
});

function getCurrentProductId(state: ChatPanelState = panel.get()): string | null {
  if (state.runtimeProductId !== null) {
    return state.runtimeProductId;
  }
  return state.label === null ? null : toProductId(state.label);
}

/** Every chat call needs a session, so a logged-out user gets no chat rather than denied calls. */
function isButtonVisible(state: ChatPanelState = panel.get()): boolean {
  return state.available && state.label !== null && state.loggedIn;
}

function getTotalUnread(state: ChatPanelState = panel.get()): number {
  let total = 0;
  for (const count of Object.values(state.unreadByRoom)) {
    total += count;
  }
  return total;
}

function setOpen(open: boolean): void {
  const state = panel.get();
  if (state.open === open) {
    return;
  }
  update(open ? { open, width: readStoredWidth() } : { open });
}

function openRoom(roomId: string): void {
  update({ activeRoomId: roomId, focusComposer: true });
}

function backToRooms(): void {
  update({ activeRoomId: null, composerError: null });
}

function clearActiveRoom(): void {
  if (panel.get().activeRoomId !== null) {
    update({ activeRoomId: null });
  }
}

function markRoomSeen(roomId: string): void {
  const { unreadByRoom } = panel.get();
  if (!(roomId in unreadByRoom)) {
    return;
  }
  const rest = { ...unreadByRoom };
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- shallow immutable copy of the unread record, removing one entry.
  delete rest[roomId];
  update({ unreadByRoom: rest });
}

function markFollowedRoomSeen(view: ReadableStore<ChatView>): () => void {
  let shown: ChatView['messages'] = null;
  function markLandedRead(): void {
    const { messages, roomId } = view.get();
    if (messages === shown) {
      return;
    }
    shown = messages;
    if (messages !== null && roomId !== null) {
      markRoomSeen(roomId);
    }
  }
  markLandedRead();
  return view.listen(markLandedRead);
}

function setComposerError(message: string | null): void {
  update({ composerError: message });
}

function consumeComposerFocus(): void {
  if (panel.get().focusComposer) {
    update({ focusComposer: false });
  }
}

function setWidth(width: number): void {
  update({ width: clampWidth(width) });
}

function persistWidth(): void {
  widthStorage.setItem(PANEL_WIDTH_KEY, String(panel.get().width));
}

function start({ chat = chatStore, storage = pageLocalStorage }: Params = {}): () => void {
  return run.join({ chat, storage });
}

function getElement(): HTMLElement | undefined {
  return panelElement;
}

function setElement(element: HTMLElement): () => void {
  panelElement = element;
  function releaseElement(): void {
    if (panelElement === element) {
      panelElement = undefined;
    }
  }
  return releaseElement;
}

function beginFollowing({ chat, storage }: Required<Params>): () => void {
  widthStorage = storage;
  followSessionAndTopbar();
  followProduct();
  const unsubscribes = [
    authState.loggedInStore.listen(followSessionAndTopbar),
    topbarState.store.listen(followSessionAndTopbar),
    productState.store.listen(followProduct),
    chat.subscribe(countUnreadMessage),
  ];
  function unsubscribe(): void {
    for (const unsubscribeOne of unsubscribes) {
      unsubscribeOne();
    }
  }
  return unsubscribe;
}

function followSessionAndTopbar(): void {
  update({
    loggedIn: authState.isLoggedIn(),
    topbarVisible: topbarState.get().visible,
  });
}

function followProduct(): void {
  const product = productState.get();
  if (product.status === 'error') {
    update({ label: null, runtimeProductId: null, available: false });
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
  commit({ ...base, runtimeProductId: productId, available: product.chat === true });
}

function countUnreadMessage(change: ChatChange): void {
  const state = panel.get();
  if (change.kind !== 'message' || change.author !== 'product' || change.productId !== getCurrentProductId(state)) {
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
}

function readStoredWidth(): number {
  const raw = Number(widthStorage.getItem(PANEL_WIDTH_KEY));
  if (Number.isFinite(raw) && raw >= MIN_PANEL_WIDTH) {
    return Math.min(raw, MAX_PANEL_WIDTH);
  }
  return DEFAULT_PANEL_WIDTH;
}

function clampWidth(width: number): number {
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, width));
}

function commit(next: ChatPanelState): void {
  panel.set(next.open && !isButtonVisible(next) ? { ...next, open: false } : next);
}

function update(patch: Partial<ChatPanelState>): void {
  commit({ ...panel.get(), ...patch });
}
