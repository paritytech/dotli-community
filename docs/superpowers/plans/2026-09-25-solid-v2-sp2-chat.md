# Solid v2 SP2 — chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the docked product-chat panel with Solid components from a lazily loaded chunk, keeping behaviour, ids, classes, copy and the product-content security model unchanged, and take the chat panel code off the host startup path.

**Architecture:** A Solid-free chat-panel store (`state/chat-panel.ts`) owns the panel's state and today's window-event rules. `chat/panel.ts` becomes a small Solid-free controller for the static topbar button, badge, more-row, the `aside#chat-panel` container and the product-iframe width. `chat/load.ts` lazily imports `components/chat/mount.tsx`, which renders `<ChatPanel/>` into the aside. `custom-renderer.ts` and `custom-message.ts` are reused unchanged.

**Tech Stack:** Solid 2 RC (`solid-js`, `@solidjs/web` `2.0.0-rc.9`), `@solidjs/testing-library`, Vitest 5 + happy-dom + fake-indexeddb, TypeScript 6 strict, Bun 1.3.13.

**Spec:** `docs/superpowers/specs/2026-09-25-solid-v2-sp2-chat-design.md` (parent: `docs/superpowers/specs/2026-09-25-solid-v2-ui-migration-design.md`).

## Global Constraints

- Branch `feat/solid-v2-foundation`, local only. Never push or open a PR.
- **Solid-free files never import `solid-js`, `@solidjs/web`, anything under `packages/ui/src/components/`, or `packages/ui/src/mount/root.ts`.** Solid-free files here: `state/chat-panel.ts`, `chat/panel.ts`, `chat/load.ts`. The only route to Solid is the dynamic `import("../components/chat/mount")` in `chat/load.ts`.
- Unchanged files: `chat/service.ts`, `chat/custom-renderer.ts`, `chat/custom-message.ts`, `state/chat.ts`, `packages/shared/src/chat-capability.ts`, `host-callbacks/Chat.ts`, `bridge.ts`, `topbar.ts`, every CSS file, and the `#chat-button`, `#chat-unread-badge`, `#more-row-chat` markup in `apps/host/index.html`.
- `initChatPanel(): void` keeps its name and export from `packages/ui/src/chat/panel.ts` (called from `initTopBar`).
- Frozen ids/classes/attributes: `chat-panel` (`role="complementary"`, `aria-label="Product chat"`), `chat-panel-resize` (`aria-hidden="true"`), `chat-panel-header`, `chat-panel-back` (title/aria-label "Back to rooms"), `chat-panel-title`, `chat-panel-close` (title/aria-label "Close chat"), `chat-panel-rooms` (`role="list"`, `aria-label="Chat rooms"`), `chat-panel-messages` (`aria-live="polite"`), `chat-panel-hint`, `chat-panel-composer`, `chat-panel-input` (`type="text"`, `placeholder="Message"`, `autocomplete="off"`, `maxlength="4000"`), `chat-panel-send` (title/aria-label "Send", `type="submit"`); `chat-room-item` (`role="listitem"`), `chat-room-icon`, `chat-room-icon-fallback`, `chat-room-name`, `chat-room-unread`; `chat-msg`, `chat-msg-user`, `chat-msg-product`, `chat-msg-bubble`, `chat-msg-event`, `chat-msg-custom`, `chat-msg-meta`, `chat-msg-actions`, `chat-msg-actions-grid`, `chat-msg-actions-column`, `chat-msg-time` (`data-timestamp`, `title`), `chat-custom-btn chat-custom-btn-secondary`; `.topbar-hidden`, `.active`, `aria-expanded`.
- Copy: "Chat", "Waiting for the app to start a chat.", "Log in to chat with this app.", "Message saved, but the app could not be reached.", "The app could not be reached.", "[unsupported message]", "reacted <emoji>", "removed reaction <emoji>", "[file] <name>", " [N attachment(s)]", relative times "just now" / "a min ago" / "N mins ago" / "an hour ago" / "N hours ago" / "yesterday" / "N days ago", unread "9+" above 9.
- Product-supplied text only ever reaches the DOM as JSX text (never `innerHTML`); product icon strings only reach `img.src`. `innerHTML` is used only for the host's own static SVG icons, with `// eslint-disable-next-line solid/no-innerhtml -- trusted SVG from host code`.
- Solid 2 RC idioms that work in this repo (see `packages/ui/src/components/overlays/*`): refs use the callback form `ref={(el) => { x = el; }}` (ESLint `no-unassigned-vars`); `class` accepts arrays with objects; `createEffect(compute, effect)`; `createMemo` dedupes equal primitive values; `onSettled` for post-render DOM work; `<For each keyed={(x) => key}>` passes accessors; non-keyed `<For>` passes raw items.
- Tests that call `vi.resetModules()` must import modules dynamically after the reset (statically imported helpers would refer to stale instances).
- Every commit passes `bun run typecheck`, `bun run lint`, `bun run test`; check changed `.ts`/`.tsx` with `bunx prettier --check <files>` (repo-wide `format:check` may flag gitignored `.superpowers/` scratch).
- Test names follow the repo style ("As a user, …" / "As a dotli integrator, …").

## Review Focus

1. A message for another room while a conversation is open must only bump that room's unread count; it must not re-fetch or re-mount the open conversation (custom messages would drop their live product subscription). Pinned in Task 1 (per-room sequence) and Task 3 (render count stays 1).
2. Leaving a conversation, closing the panel, or switching rooms must dispose every live custom-message subscription. Pinned by the existing chat-panel test and in Task 2.
3. A product (re)load with a different label while the panel is open must clear the open room, unread counts and composer error, and show the new product's contacts. Pinned in Task 1 and Task 3.
4. The chat chunk failing to load must not leave the panel open and empty; it closes and the next open retries. Pinned in Task 3.
5. A custom message's live content must render before its timestamp inside the bubble, as today. Pinned in Task 2.

---

### Task 1: Chat-panel store

**Files:**
- Create: `packages/ui/src/state/chat-panel.ts`
- Test: `packages/ui/tests/state/chat-panel.test.ts`

**Interfaces:**
- Consumes: `createSyncStore`, `ReadableStore` (`state/create-store.ts`); `CHAT_AVAILABILITY_EVENT`, `ChatAvailabilityDetail` (`@dotli/shared/chat-capability`); `CHAT_MESSAGE_EVENT`, `CHAT_ROOMS_CHANGED_EVENT`, `CHAT_BOTS_CHANGED_EVENT`, `ChatMessageEventDetail` (`chat/service.ts`); `labelToProductId` (`runtime-config.ts`).
- Produces (exact):
  ```ts
  export const PANEL_WIDTH_KEY = "dotli:chat-panel-width";
  export const MIN_PANEL_WIDTH = 280; export const MAX_PANEL_WIDTH = 560; export const DEFAULT_PANEL_WIDTH = 360;
  export interface ChatPanelState {
    label: string | null; runtimeProductId: string | null; available: boolean; loggedIn: boolean;
    open: boolean; activeRoomId: string | null; unreadByRoom: Readonly<Record<string, number>>;
    roomSeq: Readonly<Record<string, number>>; contactsVersion: number;
    composerError: string | null; focusComposer: boolean; width: number; topbarVisible: boolean;
  }
  export const chatPanelStore: ReadableStore<ChatPanelState>;
  export function currentChatProductId(state?: ChatPanelState): string | null;
  export function chatButtonVisible(state?: ChatPanelState): boolean;
  export function totalChatUnread(state?: ChatPanelState): number;
  export function chatUnreadLabel(count: number): string;
  export function setChatPanelOpen(open: boolean): void;
  export function openChatRoom(roomId: string): void;
  export function backToChatRooms(): void;
  export function clearActiveChatRoom(): void;
  export function markChatRoomSeen(roomId: string): void;
  export function setChatComposerError(message: string | null): void;
  export function consumeComposerFocus(): void;
  export function setChatPanelWidth(width: number): void;
  export function persistChatPanelWidth(): void;
  export function initChatPanelState(): () => void;
  export function resetChatPanelStateForTests(): void;
  ```

- [ ] **Step 1: Write the failing tests**

`packages/ui/tests/state/chat-panel.test.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHAT_AVAILABILITY_EVENT } from "@dotli/shared/chat-capability";
import {
  CHAT_BOTS_CHANGED_EVENT,
  CHAT_MESSAGE_EVENT,
  CHAT_ROOMS_CHANGED_EVENT,
} from "@dotli/ui/chat/service";
import { labelToProductId } from "@dotli/ui/runtime-config";
import {
  backToChatRooms,
  chatButtonVisible,
  chatPanelStore,
  chatUnreadLabel,
  currentChatProductId,
  initChatPanelState,
  markChatRoomSeen,
  openChatRoom,
  persistChatPanelWidth,
  resetChatPanelStateForTests,
  setChatComposerError,
  setChatPanelOpen,
  setChatPanelWidth,
  totalChatUnread,
} from "@dotli/ui/state/chat-panel";

let remove: () => void = () => undefined;

function fire(name: string, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function showProduct(label: string): void {
  fire("dotli:product-loaded", { label });
  fire(CHAT_AVAILABILITY_EVENT, { label, chat: true });
  fire("dotli:truapi-auth-state", { tag: "Connected" });
}

function productMessage(label: string, roomId: string): void {
  fire(CHAT_MESSAGE_EVENT, { productId: labelToProductId(label), roomId, author: "product" });
}

beforeEach(() => {
  localStorage.clear();
  remove = initChatPanelState();
});

afterEach(() => {
  remove();
  resetChatPanelStateForTests();
});

describe("chat panel state", () => {
  it("As a user, the chat button shows only for a chat-capable product while I am logged in", () => {
    // Given
    fire("dotli:product-loaded", { label: "app" });

    // Then
    expect(chatButtonVisible()).toBe(false);

    // When
    fire(CHAT_AVAILABILITY_EVENT, { label: "app", chat: true });

    // Then
    expect(chatButtonVisible()).toBe(false);

    // When
    fire("dotli:truapi-auth-state", { tag: "Connected" });

    // Then
    expect(chatButtonVisible()).toBe(true);

    // When: transitional login states change nothing
    fire("dotli:truapi-auth-state", { tag: "Pairing" });

    // Then
    expect(chatButtonVisible()).toBe(true);
  });

  it("As a user, availability for another product is ignored", () => {
    // Given
    showProduct("app");

    // When
    fire(CHAT_AVAILABILITY_EVENT, { label: "other", chat: false });

    // Then
    expect(chatButtonVisible()).toBe(true);
  });

  it("As a user, the panel closes when the button goes away (logout or product error)", () => {
    // Given
    showProduct("app");
    setChatPanelOpen(true);

    // When
    fire("dotli:truapi-auth-state", { tag: "Disconnected" });

    // Then
    expect(chatPanelStore.get().open).toBe(false);

    // When
    fire("dotli:truapi-auth-state", { tag: "Connected" });
    setChatPanelOpen(true);
    fire("dotli:product-error", undefined);

    // Then
    expect(chatPanelStore.get().open).toBe(false);
    expect(currentChatProductId()).toBeNull();
  });

  it("As a user, product messages outside the room I am viewing count as unread, per room", () => {
    // Given
    showProduct("app");

    // When
    productMessage("app", "a");
    productMessage("app", "a");
    productMessage("app", "b");

    // Then
    expect(chatPanelStore.get().unreadByRoom).toEqual({ a: 2, b: 1 });
    expect(totalChatUnread()).toBe(3);

    // When: viewing room a, a new message there is seen at once
    setChatPanelOpen(true);
    openChatRoom("a");
    markChatRoomSeen("a");
    productMessage("app", "a");

    // Then
    expect(chatPanelStore.get().unreadByRoom).toEqual({ b: 1 });
  });

  it("As a user, my own messages and messages for another product do not count as unread", () => {
    // Given
    showProduct("app");

    // When
    fire(CHAT_MESSAGE_EVENT, { productId: labelToProductId("app"), roomId: "a", author: "user" });
    productMessage("other", "a");

    // Then
    expect(totalChatUnread()).toBe(0);
  });

  it("As a dotli integrator, each message bumps only its own room's sequence, and any change bumps the contact version", () => {
    // Given
    showProduct("app");
    const before = chatPanelStore.get().contactsVersion;

    // When
    productMessage("app", "a");
    productMessage("app", "b");
    fire(CHAT_ROOMS_CHANGED_EVENT, { productId: labelToProductId("app") });
    fire(CHAT_BOTS_CHANGED_EVENT, { productId: labelToProductId("app") });
    fire(CHAT_ROOMS_CHANGED_EVENT, { productId: labelToProductId("other") });

    // Then
    expect(chatPanelStore.get().roomSeq).toEqual({ a: 1, b: 1 });
    expect(chatPanelStore.get().contactsVersion).toBe(before + 4);
  });

  it("As a user, loading a different product resets the open room, unread counts and composer error", () => {
    // Given
    showProduct("app");
    productMessage("app", "a");
    setChatPanelOpen(true);
    openChatRoom("a");
    setChatComposerError("oops");

    // When
    fire("dotli:product-loaded", { label: "next", productId: "next.dot" });

    // Then
    const state = chatPanelStore.get();
    expect(state.activeRoomId).toBeNull();
    expect(state.unreadByRoom).toEqual({});
    expect(state.composerError).toBeNull();
    expect(currentChatProductId()).toBe("next.dot");
  });

  it("As a user, going back to the room list clears the composer error", () => {
    // Given
    showProduct("app");
    setChatPanelOpen(true);
    openChatRoom("a");
    setChatComposerError("oops");

    // When
    backToChatRooms();

    // Then
    expect(chatPanelStore.get().activeRoomId).toBeNull();
    expect(chatPanelStore.get().composerError).toBeNull();
  });

  it("As a user, the panel width is clamped, persisted, and restored when the panel opens", () => {
    // Given
    showProduct("app");

    // When
    setChatPanelWidth(9999);
    persistChatPanelWidth();

    // Then
    expect(chatPanelStore.get().width).toBe(560);
    expect(localStorage.getItem("dotli:chat-panel-width")).toBe("560");

    // When
    setChatPanelWidth(10);

    // Then
    expect(chatPanelStore.get().width).toBe(280);

    // When
    setChatPanelOpen(true);

    // Then
    expect(chatPanelStore.get().width).toBe(560);
  });

  it("As a user, the topbar visibility is tracked for the panel", () => {
    // When
    fire("topbar:visibility", false);

    // Then
    expect(chatPanelStore.get().topbarVisible).toBe(false);
  });

  it("As a user, unread counts above nine read 9+", () => {
    expect(chatUnreadLabel(3)).toBe("3");
    expect(chatUnreadLabel(10)).toBe("9+");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run --cwd packages/ui test tests/state/chat-panel.test.ts`
Expected: FAIL, cannot resolve `@dotli/ui/state/chat-panel`.

- [ ] **Step 3: Write the store**

`packages/ui/src/state/chat-panel.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run --cwd packages/ui test tests/state/chat-panel.test.ts`
Expected: 11 passed.

Run: `bun run --cwd packages/ui typecheck && bun run --cwd packages/ui lint && bun run --cwd packages/ui test`
Expected: all pass (nothing else uses the new file yet).

- [ ] **Step 5: Commit**

```bash
bunx prettier --write packages/ui/src/state/chat-panel.ts packages/ui/tests/state/chat-panel.test.ts
git add packages/ui/src/state/chat-panel.ts packages/ui/tests/state/chat-panel.test.ts
git commit -m "feat(ui): add Solid-free chat panel store"
```

---

### Task 2: Contact helpers, contact icon and message bubble

**Files:**
- Create: `packages/ui/src/components/chat/contacts.ts` (pure, no Solid)
- Create: `packages/ui/src/components/chat/ContactIcon.tsx`
- Create: `packages/ui/src/components/chat/MessageBubble.tsx`
- Test: `packages/ui/tests/components/chat/message-bubble.test.tsx`

**Interfaces:**
- Consumes: `ChatBotRecord`, `ChatMessageRecord`, `ChatRoomRecord`, `userTriggerAction` (`chat/service.ts`); `mountCustomMessage`, `CustomMessageMount` (`chat/custom-message.ts`); `ChatMessageContent` (`@parity/truapi`).
- Produces:
  ```ts
  // contacts.ts
  export interface ContactEntry { kind: "room" | "bot"; id: string; name: string; icon: string; createdAt: number; lastMessageAt: number | null }
  export function contactEntries(rooms: ChatRoomRecord[], bots: ChatBotRecord[], lastMessageTimes: Map<string, number>): ContactEntry[];
  export function relativeTime(timestamp: number, now: number): string;
  // ContactIcon.tsx
  export function ContactIcon(props: { name: string; icon: string; iconClass: string }): JSX.Element;
  // MessageBubble.tsx
  export function MessageBubble(props: { record: ChatMessageRecord; now: number; onActionError: () => void }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing tests**

`packages/ui/tests/components/chat/message-bubble.test.tsx`:

```tsx
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

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
import { contactEntries, relativeTime } from "@dotli/ui/components/chat/contacts";
import { renderComponent, settle } from "../../helpers/solid";

const NOW = 1_700_000_000_000;

function record(content: unknown, author: "product" | "user" = "product"): ChatMessageRecord {
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

async function show(content: unknown, author: "product" | "user" = "product", onActionError = vi.fn()): Promise<HTMLElement> {
  const view = renderComponent(() => (
    <MessageBubble record={record(content, author)} now={NOW} onActionError={onActionError} />
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
    const row = await show({ tag: "Text", value: { text: "hello <b>there</b>" } });

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
    const rich = await show({ tag: "RichText", value: { text: "pics", media: [{}, {}] } });

    // Then
    expect(rich.querySelector(".chat-msg-bubble")?.textContent).toContain("pics");
    expect(rich.querySelector(".chat-msg-meta")?.textContent).toBe(" [2 attachments]");
    document.body.replaceChildren();

    const reaction = await show({ tag: "Reaction", value: { emoji: "👍" } });
    expect(reaction.querySelector(".chat-msg-bubble")?.className).toBe("chat-msg-bubble chat-msg-event");
    expect(reaction.querySelector(".chat-msg-bubble")?.textContent).toContain("reacted 👍");
    document.body.replaceChildren();

    const removed = await show({ tag: "ReactionRemoved", value: { emoji: "👍" } });
    expect(removed.querySelector(".chat-msg-bubble")?.textContent).toContain("removed reaction 👍");
    document.body.replaceChildren();

    const file = await show({ tag: "File", value: { fileName: "a.pdf" } });
    expect(file.querySelector(".chat-msg-bubble")?.textContent).toContain("[file] a.pdf");
    document.body.replaceChildren();

    const unknown = await show({ tag: "Hologram", value: {} });
    expect(unknown.querySelector(".chat-msg-bubble")?.className).toBe("chat-msg-bubble chat-msg-event");
    expect(unknown.querySelector(".chat-msg-bubble")?.textContent).toContain("[unsupported message]");
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
    expect(row.querySelector(".chat-msg-actions")?.className).toBe("chat-msg-actions chat-msg-actions-grid");
    const buttons = [...row.querySelectorAll<HTMLButtonElement>(".chat-msg-actions button")];
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
        record={record({ tag: "Custom", value: { messageType: "poll", payload: "0x01" } })}
        now={NOW}
        onActionError={vi.fn()}
      />
    ));
    await settle();

    // Then
    const bubble = view.container.querySelector<HTMLElement>(".chat-msg-bubble")!;
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
        <ContactIcon name="Support" icon="https://example.invalid/x.png" iconClass="chat-room-icon" />
      </>
    ));
    await settle();

    // Then
    const fallback = view.container.querySelector(".chat-room-icon-fallback")!;
    expect(fallback.textContent).toBe("G");
    expect(fallback.getAttribute("aria-hidden")).toBe("true");
    const img = view.container.querySelector<HTMLImageElement>("img.chat-room-icon")!;
    expect(img.alt).toBe("");

    // When: the image fails to load
    fireEvent.error(img);
    await settle();

    // Then
    expect(view.container.querySelectorAll(".chat-room-icon-fallback")).toHaveLength(2);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run --cwd packages/ui test tests/components/chat/message-bubble.test.tsx`
Expected: FAIL, cannot resolve `@dotli/ui/components/chat/MessageBubble`.

- [ ] **Step 3: Write the helpers and components**

`packages/ui/src/components/chat/contacts.ts` (pure; moved from `chat/panel.ts`):

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  ChatBotRecord,
  ChatRoomRecord,
} from "../../chat/service";

/** One list entry: a room, or a registered bot. Both open a conversation;
 *  a bot's is keyed by its botId, which the product uses as the roomId when
 *  it posts into or reads from that conversation. */
export interface ContactEntry {
  kind: "room" | "bot";
  id: string;
  name: string;
  icon: string;
  createdAt: number;
  // null until the conversation has messages; the list then falls back to
  // creation time, so one recency order covers active and new contacts.
  lastMessageAt: number | null;
}

export function contactEntries(
  rooms: ChatRoomRecord[],
  bots: ChatBotRecord[],
  lastMessageTimes: Map<string, number>,
): ContactEntry[] {
  const entries: ContactEntry[] = [
    ...rooms.map((room) => ({
      kind: "room" as const,
      id: room.roomId,
      name: room.name,
      icon: room.icon,
      createdAt: room.createdAt,
      lastMessageAt: lastMessageTimes.get(room.roomId) ?? null,
    })),
    ...bots.map((bot) => ({
      kind: "bot" as const,
      id: bot.botId,
      name: bot.name,
      icon: bot.icon,
      createdAt: bot.createdAt,
      lastMessageAt: lastMessageTimes.get(bot.botId) ?? null,
    })),
  ];
  const recency = (entry: ContactEntry): number =>
    entry.lastMessageAt ?? entry.createdAt;
  return entries.sort((a, b) => recency(b) - recency(a));
}

/** "just now" / "5 mins ago" / "an hour ago" style label for a bubble. */
export function relativeTime(timestamp: number, now: number): string {
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
```

`packages/ui/src/components/chat/ContactIcon.tsx`:

```tsx
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, Show } from "solid-js";
import type { JSX } from "@solidjs/web";

/** Circular contact icon; falls back to the name's initial when there is no
 *  usable image. The icon string is product-supplied, so it only ever
 *  becomes an `img.src`, never markup. */
export function ContactIcon(props: {
  name: string;
  icon: string;
  iconClass: string;
}): JSX.Element {
  const [failed, setFailed] = createSignal(false);
  const initial = (): string =>
    (props.name.trim().charAt(0) || "#").toUpperCase();
  return (
    <Show
      when={props.icon !== "" && !failed()}
      fallback={
        <span
          class={`${props.iconClass} ${props.iconClass}-fallback`}
          aria-hidden="true"
        >
          {initial()}
        </span>
      }
    >
      <img
        class={props.iconClass}
        alt=""
        src={props.icon}
        onError={() => setFailed(true)}
      />
    </Show>
  );
}
```

`packages/ui/src/components/chat/MessageBubble.tsx`:

```tsx
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One message row. Product text only ever lands as JSX text, so it cannot
// inject markup; custom messages go through custom-message.ts, whose
// renderer maps a closed token vocabulary to DOM.

import { For, onCleanup, onSettled, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { ChatMessageContent } from "@parity/truapi";
import { mountCustomMessage } from "../../chat/custom-message";
import {
  userTriggerAction,
  type ChatMessageRecord,
} from "../../chat/service";
import { relativeTime } from "./contacts";

export function MessageBubble(props: {
  record: ChatMessageRecord;
  now: number;
  onActionError: () => void;
}): JSX.Element {
  // Records are immutable and the list keys rows by seq, so read once.
  // eslint-disable-next-line solid/reactivity -- immutable keyed record
  const record = props.record;
  const content = record.content as ChatMessageContent;

  const time = (
    <time
      class="chat-msg-time"
      data-timestamp={String(record.timestamp)}
      title={new Date(record.timestamp).toLocaleString()}
    >
      {relativeTime(record.timestamp, props.now)}
    </time>
  );

  const bubble = (): JSX.Element => {
    switch (content.tag) {
      case "Text":
        return (
          <div class="chat-msg-bubble">
            {content.value.text}
            {time}
          </div>
        );
      case "RichText": {
        const count = content.value.media.length;
        return (
          <div class="chat-msg-bubble">
            {content.value.text ?? ""}
            <Show when={count > 0}>
              <span class="chat-msg-meta">
                {` [${String(count)} attachment${count === 1 ? "" : "s"}]`}
              </span>
            </Show>
            {time}
          </div>
        );
      }
      case "Reaction":
        return (
          <div class="chat-msg-bubble chat-msg-event">
            {`reacted ${content.value.emoji}`}
            {time}
          </div>
        );
      case "ReactionRemoved":
        return (
          <div class="chat-msg-bubble chat-msg-event">
            {`removed reaction ${content.value.emoji}`}
            {time}
          </div>
        );
      case "File":
        return (
          <div class="chat-msg-bubble">
            {`[file] ${content.value.fileName}`}
            {time}
          </div>
        );
      case "Actions":
        return (
          <div class="chat-msg-bubble">
            <Show when={content.value.text !== undefined && content.value.text !== ""}>
              <span>{content.value.text}</span>
            </Show>
            <div
              class={`chat-msg-actions chat-msg-actions-${content.value.layout === "Grid" ? "grid" : "column"}`}
            >
              <For each={content.value.actions}>
                {(action) => (
                  <button
                    type="button"
                    class="chat-custom-btn chat-custom-btn-secondary"
                    onClick={() => {
                      void userTriggerAction(record.productId, record.roomId, {
                        messageId: record.messageId,
                        actionId: action.actionId,
                      }).catch(() => {
                        props.onActionError();
                      });
                    }}
                  >
                    {action.title}
                  </button>
                )}
              </For>
            </div>
            {time}
          </div>
        );
      case "Custom": {
        let host: HTMLDivElement | undefined;
        let dispose: (() => void) | undefined;
        onSettled(() => {
          if (host === undefined) {
            return;
          }
          dispose = mountCustomMessage(host, {
            productId: record.productId,
            roomId: record.roomId,
            messageId: record.messageId,
            messageType: content.value.messageType,
            payload: content.value.payload,
          });
          // mountCustomMessage appends its root; keep it before the time.
          const root = host.lastElementChild;
          if (root !== null && root !== host.firstElementChild) {
            host.insertBefore(root, host.firstChild);
          }
        });
        onCleanup(() => dispose?.());
        return (
          <div
            class="chat-msg-bubble chat-msg-custom"
            ref={(el) => {
              host = el;
            }}
          >
            {time}
          </div>
        );
      }
      default:
        return (
          <div class="chat-msg-bubble chat-msg-event">
            [unsupported message]
            {time}
          </div>
        );
    }
  };

  return (
    <div
      class={`chat-msg ${record.author === "user" ? "chat-msg-user" : "chat-msg-product"}`}
    >
      {bubble()}
    </div>
  );
}
```

If TypeScript narrows `default` to `never` and rejects the unused branch, keep the branch (runtime data can hold unknown tags, as today) and satisfy the checker with the smallest change, e.g. `switch ((content as { tag: string }).tag)` inside a helper, noting it in the report. If the `onSettled` placement inside `switch` is rejected by the Solid lint rules, hoist the Custom branch into its own component `CustomBubble` in the same file with the same logic.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run --cwd packages/ui test tests/components/chat/message-bubble.test.tsx`
Expected: 8 passed.

Run: `bun run --cwd packages/ui typecheck && bun run --cwd packages/ui lint && bun run --cwd packages/ui test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
bunx prettier --write packages/ui/src/components/chat/contacts.ts packages/ui/src/components/chat/ContactIcon.tsx packages/ui/src/components/chat/MessageBubble.tsx packages/ui/tests/components/chat/message-bubble.test.tsx
git add packages/ui/src/components/chat/contacts.ts packages/ui/src/components/chat/ContactIcon.tsx packages/ui/src/components/chat/MessageBubble.tsx packages/ui/tests/components/chat/message-bubble.test.tsx
git commit -m "feat(ui): add Solid chat message and contact components"
```

---

### Task 3: Chat panel components, lazy loader and controller

**Files:**
- Create: `packages/ui/src/components/chat/ResizeHandle.tsx`
- Create: `packages/ui/src/components/chat/ChatPanel.tsx`
- Create: `packages/ui/src/components/chat/mount.tsx`
- Create: `packages/ui/src/chat/load.ts`
- Rewrite: `packages/ui/src/chat/panel.ts` (controller only)
- Modify: `apps/host/index.html` (empty the `aside#chat-panel`)
- Modify: `packages/ui/tests/chat-panel.test.ts` (fixture + new tests; existing assertions unchanged)

**Interfaces:**
- Consumes: Task 1 store API; Task 2 `ContactEntry`, `contactEntries`, `ContactIcon`, `MessageBubble`; `chatRooms`, `chatBots`, `chatLatestMessageTimes`, `chatMessages`, `userPostMessage`, `ChatMessageRecord` (`chat/service.ts`); `getActiveRootManifest` (`@dotli/shared/active-manifest`); `mountRoot` (`mount/root.ts`); `useStore`; `captureException` (`@dotli/metrics/sentry`).
- Produces: `initChatPanel(): void` (unchanged name); `ensureChatPanel(): Promise<void>` (never rejects), `prefetchChatPanel(): void`, `resetChatPanelLoaderForTests(): void` in `chat/load.ts`; `mountChatPanel(onBroken: () => void): () => void` in `components/chat/mount.tsx`; `ChatPanel(): JSX.Element`.

- [ ] **Step 1: Update the integration tests (they become the failing tests)**

In `packages/ui/tests/chat-panel.test.ts`:

1. Replace `installChatDom()` so it matches `index.html` after this task (empty aside) and includes a product iframe:

```ts
function installChatDom(): void {
  document.body.innerHTML = `
    <button id="chat-button" aria-expanded="false" hidden>
      <span id="chat-unread-badge" hidden></span>
    </button>
    <button id="more-row-chat" hidden></button>
    <aside class="chat-panel" id="chat-panel" role="complementary" aria-label="Product chat" hidden></aside>
    <div id="app"><iframe></iframe></div>
  `;
}
```

2. Keep every existing test and assertion unchanged. They already wait with `settle(...)` (a `vi.waitFor` poll) where content renders asynchronously, which covers the lazy chunk load.

3. Append these tests inside the `describe`:

```ts
  it("As a user, opening the panel narrows the app and closing restores it", async () => {
    const { panel } = await loadChatModules();
    panel.initChatPanel();
    loadProduct("chatty-iframe");
    const iframe = document.querySelector<HTMLIFrameElement>("#app iframe")!;

    byId("chat-button").click();
    expect(byId("chat-panel").hidden).toBe(false);
    expect(byId("chat-button").getAttribute("aria-expanded")).toBe("true");
    expect(byId("chat-button").classList.contains("active")).toBe(true);
    expect(byId("chat-panel").style.width).toBe("360px");
    expect(iframe.style.width.startsWith("calc(100vw - ")).toBe(true);

    await settle(() => document.getElementById("chat-panel-close") !== null);
    byId("chat-panel-close").click();
    expect(byId("chat-panel").hidden).toBe(true);
    expect(byId("chat-button").getAttribute("aria-expanded")).toBe("false");
    expect(iframe.style.width).toBe("100%");
  });

  it("As a user, Escape closes the panel and returns focus to the chat button", async () => {
    const { panel } = await loadChatModules();
    panel.initChatPanel();
    loadProduct("chatty-escape");

    byId("chat-button").click();
    await settle(() => document.getElementById("chat-panel-close") !== null);
    byId("chat-panel-close").focus();
    byId("chat-panel").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );

    expect(byId("chat-panel").hidden).toBe(true);
    expect(document.activeElement).toBe(byId("chat-button"));
  });

  it("As a user, a message for another room does not reload the conversation I am reading", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    try {
      const { panel, service } = await loadChatModules();
      panel.initChatPanel();
      loadProduct("chatty-steady");
      const productId = labelToProductId("chatty-steady");
      const render = vi.fn(() => () => undefined);
      service.registerChatConnection(productId, {
        publish: async () => undefined,
        publishRendererAction: async () => undefined,
        render,
      });
      await service.productCreateRoom(productId, { roomId: "main", name: "Main", icon: "" });
      await new Promise((resolve) => setTimeout(resolve, 2));
      await service.productCreateRoom(productId, { roomId: "side", name: "Side", icon: "" });
      await service.productPostMessage(productId, "main", {
        tag: "Custom",
        value: { messageType: "poll", payload: "0x01" },
      });

      byId("chat-button").click();
      await settle(() => document.querySelectorAll(".chat-room-item").length === 2);
      [...document.querySelectorAll<HTMLButtonElement>(".chat-room-item")]
        .find((row) => row.textContent?.includes("Main"))
        ?.click();
      await settle(() => render.mock.calls.length === 1);

      await service.productPostMessage(productId, "side", {
        tag: "Text",
        value: { text: "elsewhere" },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(render).toHaveBeenCalledTimes(1);
      expect(byId("chat-panel-title").textContent).toBe("Main");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("As a user, loading another product while the panel is open shows that product's contacts", async () => {
    const { panel, service } = await loadChatModules();
    panel.initChatPanel();
    loadProduct("first-app");
    await service.productCreateRoom(labelToProductId("first-app"), { roomId: "a", name: "First room", icon: "" });
    await service.productCreateRoom(labelToProductId("second-app"), { roomId: "b", name: "Second room", icon: "" });

    byId("chat-button").click();
    await settle(() => byId("chat-panel-rooms").textContent?.includes("First room") === true);
    document.querySelector<HTMLButtonElement>(".chat-room-item")?.click();
    await settle(() => byId("chat-panel-rooms").hidden);

    loadProduct("second-app");
    await settle(() => byId("chat-panel-rooms").textContent?.includes("Second room") === true);
    expect(byId("chat-panel-rooms").hidden).toBe(false);
    expect(byId("chat-panel-rooms").textContent).not.toContain("First room");
  });

  it("As a user, if the chat code cannot load, the panel closes and the next open retries", async () => {
    vi.resetModules();
    vi.doMock("@dotli/ui/components/chat/mount", () => {
      throw new Error("chunk failed");
    });
    try {
      const panel = await import("@dotli/ui/chat/panel");
      const load = await import("@dotli/ui/chat/load");
      panel.initChatPanel();
      loadProduct("chatty-broken");

      byId("chat-button").click();
      await load.ensureChatPanel();

      expect(byId("chat-panel").hidden).toBe(true);
    } finally {
      vi.doUnmock("@dotli/ui/components/chat/mount");
      vi.resetModules();
    }
  });
```

(`vi` is already imported in this file. Keep the "cannot load" test last in the `describe`, with a one-line comment that it replaces the module registry.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run --cwd packages/ui test tests/chat-panel.test.ts`
Expected: FAIL. The current `panel.ts` bails out because the fixture's aside has no children (`getElements()` returns null), so the button never appears.

- [ ] **Step 3: Write the components**

`packages/ui/src/components/chat/ResizeHandle.tsx`:

```tsx
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from "@solidjs/web";
import {
  persistChatPanelWidth,
  setChatPanelWidth,
} from "../../state/chat-panel";

/** Drag handle on the panel's left edge. */
export function ResizeHandle(): JSX.Element {
  let handle: HTMLDivElement | undefined;

  const onPointerDown = (down: PointerEvent): void => {
    const panel = handle?.closest<HTMLElement>("#chat-panel");
    if (handle === undefined || panel == null) {
      return;
    }
    const target = handle;
    down.preventDefault();
    target.setPointerCapture(down.pointerId);
    const startX = down.clientX;
    const startWidth = panel.offsetWidth;
    const onMove = (move: PointerEvent): void => {
      setChatPanelWidth(startWidth + (startX - move.clientX));
    };
    // pointercancel is never followed by pointerup, so both ends of the drag
    // must detach the listeners or they leak and act on later hovers.
    const onEnd = (): void => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onEnd);
      target.removeEventListener("pointercancel", onEnd);
      persistChatPanelWidth();
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onEnd);
    target.addEventListener("pointercancel", onEnd);
  };

  return (
    <div
      class="chat-panel-resize"
      id="chat-panel-resize"
      aria-hidden="true"
      ref={(el) => {
        handle = el;
      }}
      onPointerDown={onPointerDown}
    />
  );
}
```

`packages/ui/src/components/chat/ChatPanel.tsx`:

```tsx
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Contents of the docked chat panel. The panel container, the topbar button
// and the product-iframe width belong to the controller (chat/panel.ts);
// this renders inside `aside#chat-panel` and reads rooms, bots and messages
// from storage whenever the chat-panel store says they may have changed.

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import type { JSX } from "@solidjs/web";
import { getActiveRootManifest } from "@dotli/shared/active-manifest";
import {
  chatBots,
  chatLatestMessageTimes,
  chatMessages,
  chatRooms,
  userPostMessage,
  type ChatMessageRecord,
} from "../../chat/service";
import {
  backToChatRooms,
  chatPanelStore,
  chatUnreadLabel,
  clearActiveChatRoom,
  consumeComposerFocus,
  currentChatProductId,
  markChatRoomSeen,
  openChatRoom,
  setChatComposerError,
  setChatPanelOpen,
} from "../../state/chat-panel";
import { useStore } from "../use-store";
import { ContactIcon } from "./ContactIcon";
import { contactEntries, type ContactEntry } from "./contacts";
import { MessageBubble } from "./MessageBubble";
import { ResizeHandle } from "./ResizeHandle";

// Relative bubble timestamps go stale while the panel sits open.
const TIME_REFRESH_MS = 60_000;

const BACK_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
const CLOSE_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const SEND_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';

type View = "loading" | "empty" | "list" | "conversation";

function ContactRow(props: {
  contact: ContactEntry;
  unread: number;
}): JSX.Element {
  return (
    <button
      type="button"
      class="chat-room-item"
      role="listitem"
      onClick={() => {
        openChatRoom(props.contact.id);
      }}
    >
      <ContactIcon
        name={props.contact.name}
        icon={props.contact.icon}
        iconClass="chat-room-icon"
      />
      <span class="chat-room-name">{props.contact.name}</span>
      <Show when={props.unread > 0}>
        <span
          class="chat-room-unread"
          aria-label={`${String(props.unread)} unread message${props.unread === 1 ? "" : "s"}`}
        >
          {chatUnreadLabel(props.unread)}
        </span>
      </Show>
    </button>
  );
}

function PanelBody(): JSX.Element {
  const state = useStore(chatPanelStore);
  const [contacts, setContacts] = createSignal<ContactEntry[] | null>(null);
  const [messages, setMessages] = createSignal<ChatMessageRecord[]>([]);
  const [refresh, setRefresh] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  let messagesEl: HTMLDivElement | undefined;
  let inputEl: HTMLInputElement | undefined;

  const timer = setInterval(() => {
    setNow(Date.now());
  }, TIME_REFRESH_MS);
  onCleanup(() => {
    clearInterval(timer);
  });

  // Contacts: re-read when the product, the session, or the contact version
  // changes. A newer read supersedes an older one that resolves late.
  const contactsKey = createMemo(() => {
    const s = state();
    const productId = currentChatProductId(s);
    return productId === null
      ? null
      : `${productId}\u0000${String(s.loggedIn)}\u0000${String(s.contactsVersion)}\u0000${String(refresh())}`;
  });
  let contactsPass = 0;
  createEffect(contactsKey, (key) => {
    const productId = currentChatProductId(chatPanelStore.get());
    if (key === null || productId === null) {
      return;
    }
    const pass = ++contactsPass;
    void Promise.all([
      chatRooms(productId),
      chatBots(productId),
      chatLatestMessageTimes(productId),
    ]).then(([rooms, bots, times]) => {
      if (pass === contactsPass) {
        setContacts(contactEntries(rooms, bots, times));
      }
    });
  });

  const activeContact = createMemo(() => {
    const id = state().activeRoomId;
    return id === null ? undefined : contacts()?.find((c) => c.id === id);
  });

  // The open room vanished, or there are no contacts: back to the list.
  createEffect(
    () => {
      const list = contacts();
      const id = state().activeRoomId;
      return list !== null && id !== null && !list.some((c) => c.id === id);
    },
    (stale) => {
      if (stale) {
        clearActiveChatRoom();
      }
    },
  );

  const view = (): View => {
    const list = contacts();
    if (list === null) {
      return "loading";
    }
    if (list.length === 0) {
      return "empty";
    }
    return activeContact() === undefined ? "list" : "conversation";
  };

  // Messages of the open room: re-read when that room gets a message (its
  // roomSeq moves) or after sending. A message for another room leaves this
  // key alone, so the conversation and its live custom renders stay put.
  const messagesKey = createMemo(() => {
    const s = state();
    const productId = currentChatProductId(s);
    const roomId = activeContact()?.id;
    return productId === null || roomId === undefined
      ? null
      : `${productId}\u0000${roomId}\u0000${String(s.roomSeq[roomId] ?? 0)}\u0000${String(refresh())}`;
  });
  let messagesPass = 0;
  let shownRoomId: string | null = null;
  createEffect(messagesKey, (key) => {
    const current = chatPanelStore.get();
    const productId = currentChatProductId(current);
    const roomId = current.activeRoomId;
    if (key === null || productId === null || roomId === null) {
      shownRoomId = null;
      setMessages([]);
      return;
    }
    if (roomId !== shownRoomId) {
      shownRoomId = roomId;
      setMessages([]);
    }
    const pass = ++messagesPass;
    void chatMessages(productId, roomId).then((records) => {
      if (pass !== messagesPass || chatPanelStore.get().activeRoomId !== roomId) {
        return;
      }
      setMessages(records);
      markChatRoomSeen(roomId);
    });
  });

  // After each message render: jump to the newest, and focus the composer
  // once after picking a room.
  createEffect(messages, () => {
    if (messagesEl !== undefined) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    if (chatPanelStore.get().focusComposer && inputEl !== undefined) {
      inputEl.focus();
      consumeComposerFocus();
    }
  });

  const title = (): string =>
    activeContact()?.name ??
    getActiveRootManifest()?.displayName ??
    state().label ??
    "Chat";

  const hint = (): string | null => {
    const v = view();
    if (v === "empty") {
      return state().loggedIn
        ? "Waiting for the app to start a chat."
        : "Log in to chat with this app.";
    }
    return v === "conversation" ? state().composerError : null;
  };

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const current = chatPanelStore.get();
    const productId = currentChatProductId(current);
    const text = inputEl?.value.trim() ?? "";
    if (productId === null || current.activeRoomId === null || text === "") {
      return;
    }
    if (inputEl !== undefined) {
      inputEl.value = "";
    }
    try {
      await userPostMessage(productId, current.activeRoomId, text);
      setChatComposerError(null);
    } catch (error) {
      setChatComposerError(
        error instanceof Error && error.message.includes("denied")
          ? "Log in to chat with this app."
          : "Message saved, but the app could not be reached.",
      );
    }
    setRefresh((n) => n + 1);
  };

  return (
    <>
      <div class="chat-panel-header">
        <button
          type="button"
          class="chat-panel-back"
          id="chat-panel-back"
          title="Back to rooms"
          aria-label="Back to rooms"
          hidden={view() !== "conversation"}
          // eslint-disable-next-line solid/no-innerhtml -- trusted SVG from host code
          innerHTML={BACK_SVG}
          onClick={() => {
            backToChatRooms();
          }}
        />
        <span class="chat-panel-title" id="chat-panel-title">
          {title()}
        </span>
        <button
          type="button"
          class="chat-panel-close"
          id="chat-panel-close"
          title="Close chat"
          aria-label="Close chat"
          // eslint-disable-next-line solid/no-innerhtml -- trusted SVG from host code
          innerHTML={CLOSE_SVG}
          onClick={() => {
            setChatPanelOpen(false);
          }}
        />
      </div>
      <div
        class="chat-panel-rooms"
        id="chat-panel-rooms"
        role="list"
        aria-label="Chat rooms"
        hidden={view() !== "list"}
      >
        <Show when={view() === "list"}>
          <For each={contacts() ?? []} keyed={(c) => c.id}>
            {(contact) => (
              <ContactRow
                contact={contact()}
                unread={state().unreadByRoom[contact().id] ?? 0}
              />
            )}
          </For>
        </Show>
      </div>
      <div
        class="chat-panel-messages"
        id="chat-panel-messages"
        aria-live="polite"
        hidden={view() !== "conversation"}
        ref={(el) => {
          messagesEl = el;
        }}
      >
        <Show when={view() === "conversation"}>
          <For each={messages()} keyed={(r) => r.seq}>
            {(record) => (
              <MessageBubble
                record={record()}
                now={now()}
                onActionError={() => {
                  setChatComposerError("The app could not be reached.");
                }}
              />
            )}
          </For>
        </Show>
      </div>
      <p class="chat-panel-hint" id="chat-panel-hint" hidden={hint() === null}>
        {hint() ?? ""}
      </p>
      <form
        class="chat-panel-composer"
        id="chat-panel-composer"
        hidden={view() !== "conversation"}
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <input
          id="chat-panel-input"
          class="chat-panel-input"
          type="text"
          placeholder="Message"
          autocomplete="off"
          maxlength="4000"
          disabled={view() !== "conversation"}
          ref={(el) => {
            inputEl = el;
          }}
        />
        <button
          type="submit"
          class="chat-panel-send"
          id="chat-panel-send"
          title="Send"
          aria-label="Send"
          // eslint-disable-next-line solid/no-innerhtml -- trusted SVG from host code
          innerHTML={SEND_SVG}
        />
      </form>
    </>
  );
}

export function ChatPanel(): JSX.Element {
  const state = useStore(chatPanelStore);
  return (
    <>
      <ResizeHandle />
      <Show when={state().open}>
        <PanelBody />
      </Show>
    </>
  );
}
```

If `createEffect(contactsKey, …)` (passing the memo accessor as the compute) is rejected by the RC's types, write `createEffect(() => contactsKey(), (key) => …)` instead, and the same for `messagesKey` and `messages`. If ESLint's `jsx` comment placement makes the `eslint-disable-next-line` inside the JSX attribute list ineffective, move the SVG into a small component (`<SvgIcon markup={BACK_SVG} />`, with the disable on its single `innerHTML` line) and say so in the report.

`packages/ui/src/components/chat/mount.tsx`:

```tsx
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Entry of the lazily loaded chat chunk. Only chat/load.ts imports it.

import { mountRoot } from "../../mount/root";
import { ChatPanel } from "./ChatPanel";

export function mountChatPanel(onBroken: () => void): () => void {
  const container = document.getElementById("chat-panel");
  if (container === null) {
    throw new Error("chat panel container is missing");
  }
  return mountRoot("chat", container, () => <ChatPanel />, {
    onError: onBroken,
  });
}
```

`packages/ui/src/chat/load.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Loads the Solid chat panel on first use, so the host startup bundle does
// not carry it. Solid-free: it only imports the chunk dynamically.

import { captureException } from "@dotli/metrics/sentry";
import { setChatPanelOpen } from "../state/chat-panel";

const PREFETCH_FALLBACK_MS = 2000;

let loading: Promise<void> | null = null;
let dispose: (() => void) | null = null;

/** A render error inside the panel: close it and remount on the next open. */
function createOnBroken(): () => void {
  let handled = false;
  return () => {
    if (handled) {
      return;
    }
    handled = true;
    // Deferred so the root is not disposed from inside its own fallback.
    queueMicrotask(() => {
      loading = null;
      dispose?.();
      dispose = null;
      setChatPanelOpen(false);
    });
  };
}

/** Import and mount the chat panel once. Never rejects. */
export function ensureChatPanel(): Promise<void> {
  loading ??= import("../components/chat/mount")
    .then(({ mountChatPanel }) => {
      dispose = mountChatPanel(createOnBroken());
    })
    .catch((err: unknown) => {
      loading = null;
      captureException(err, { kind: "chat_panel_load_error" });
      setChatPanelOpen(false);
    });
  return loading;
}

/** Load the panel when the browser is idle, before the user opens it. */
export function prefetchChatPanel(): void {
  const run = (): void => {
    void ensureChatPanel();
  };
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run);
  } else {
    setTimeout(run, PREFETCH_FALLBACK_MS);
  }
}

/** Tests only. */
export function resetChatPanelLoaderForTests(): void {
  loading = null;
  dispose = null;
}
```

- [ ] **Step 4: Rewrite the controller**

`packages/ui/src/chat/panel.ts` (whole file):

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Docked product-chat panel: the Solid-free part that runs at boot.
//
// The topbar button appears when the loaded product declares chat in its
// worker manifest (announced via `dotli:chat-availability`) and a session is
// active. The panel docks to the right edge and shrinks the product iframe
// while open, mirroring the debug panel's right dock. Its contents are Solid
// components loaded on first use (components/chat/ChatPanel.tsx).

import {
  chatButtonVisible,
  chatPanelStore,
  chatUnreadLabel,
  initChatPanelState,
  setChatPanelOpen,
  totalChatUnread,
} from "../state/chat-panel";
import { ensureChatPanel, prefetchChatPanel } from "./load";

function adjustIframe(panel: HTMLElement, open: boolean): void {
  const iframe = document.querySelector<HTMLIFrameElement>("#app iframe");
  if (iframe === null) {
    return;
  }
  iframe.style.width = open
    ? `calc(100vw - ${String(panel.offsetWidth)}px)`
    : "100%";
}

/** Wire the chat button + panel. Called once from `initTopBar`. */
export function initChatPanel(): void {
  const button = document.getElementById("chat-button");
  const moreRow = document.getElementById("more-row-chat");
  const badge = document.getElementById("chat-unread-badge");
  const panel = document.getElementById("chat-panel");
  if (button === null || moreRow === null || badge === null || panel === null) {
    return;
  }

  initChatPanelState();

  let wasOpen = false;
  let prefetched = false;
  const sync = (): void => {
    const state = chatPanelStore.get();
    const visible = chatButtonVisible(state);
    button.hidden = !visible;
    moreRow.hidden = !visible;
    // While the panel is open the room rows carry their own badges.
    const unread = state.open ? 0 : totalChatUnread(state);
    badge.hidden = unread === 0;
    badge.textContent = chatUnreadLabel(unread);
    button.setAttribute("aria-expanded", state.open ? "true" : "false");
    button.classList.toggle("active", state.open);
    panel.hidden = !state.open;
    // The auto-hidden topbar frees its strip; stretch the panel into it.
    panel.classList.toggle("topbar-hidden", !state.topbarVisible);
    if (state.open) {
      panel.style.width = `${String(state.width)}px`;
    }
    if (state.open || wasOpen) {
      adjustIframe(panel, state.open);
    }
    wasOpen = state.open;
    if (visible && !prefetched) {
      prefetched = true;
      prefetchChatPanel();
    }
    if (state.open) {
      void ensureChatPanel();
    }
  };
  chatPanelStore.subscribe(sync);
  sync();

  button.addEventListener("click", () => {
    setChatPanelOpen(!chatPanelStore.get().open);
  });
  panel.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      setChatPanelOpen(false);
      button.focus();
    }
  });
}
```

Note: `sync` is a store listener and must not call store setters. It does not; `ensureChatPanel`'s failure path calls `setChatPanelOpen` asynchronously (after the import rejects), not during notification.

- [ ] **Step 5: Empty the aside in `index.html`**

In `apps/host/index.html`, replace the whole `<aside class="chat-panel" id="chat-panel" …>…</aside>` block (the one after the "Chat Panel" comment) with:

```html
        <!-- Chat Panel (docked right; the panel runtime shrinks the product
             iframe while open, mirroring the debug panel's right dock).
             Contents are rendered by components/chat/ChatPanel.tsx. -->
        <aside class="chat-panel" id="chat-panel" role="complementary" aria-label="Product chat" hidden></aside>
```

Keep the original comment's first two lines as shown and remove the old comment so it is not duplicated.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun run --cwd packages/ui test tests/chat-panel.test.ts`
Expected: all pass (the 10 existing tests unchanged + 5 new).

Run: `grep -nE "solid-js|@solidjs|/components/|mount/root" packages/ui/src/chat/panel.ts packages/ui/src/chat/load.ts packages/ui/src/state/chat-panel.ts`
Expected: only the `import("../components/chat/mount")` line in `load.ts`.

Run: `grep -n "createElement\|replaceChildren\|getElementById(\"chat-panel-" packages/ui/src/chat/panel.ts`
Expected: no output (the DOM-building code is gone).

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all pass. `chat-custom-renderer.test.ts` and `state/chat.test.ts` are untouched and still pass.

- [ ] **Step 7: Commit**

```bash
bunx prettier --write packages/ui/src/components/chat/ResizeHandle.tsx packages/ui/src/components/chat/ChatPanel.tsx packages/ui/src/components/chat/mount.tsx packages/ui/src/chat/load.ts packages/ui/src/chat/panel.ts packages/ui/tests/chat-panel.test.ts
git add packages/ui/src/components/chat/ResizeHandle.tsx packages/ui/src/components/chat/ChatPanel.tsx packages/ui/src/components/chat/mount.tsx packages/ui/src/chat/load.ts packages/ui/src/chat/panel.ts packages/ui/tests/chat-panel.test.ts apps/host/index.html
git commit -m "refactor(ui): render the chat panel with Solid from a lazy chunk"
```

---

### Task 4: Gates and verification

**Files:**
- Modify: `docs/perf/solid-migration-baseline.md` (new section "After sub-project 2")

Placeholders: `<repo>` is the repository root; `<scratchpad>` is the session scratchpad directory the controller gives you; `<BASE>` is the SP2 spec commit `30d41161` (its code equals the branch before sub-project 2).

- [ ] **Step 1: Functional suite**

```bash
lsof -ti tcp:5173 | xargs kill 2>/dev/null; true
VITE_NETWORKS=paseo-next-v2,previewnet bun run build
bun run --cwd apps/host test:functional
```

Run it in the background with a log; expected 41 passed, 2 skipped. A failure in a network-dependent test gets one re-run of only the failed tests; report both runs.

- [ ] **Step 2: Startup bundle and Solid checks**

On that build: `bun scripts/eager-path-size.ts apps/host/dist` and `bun scripts/eager-path-size.ts apps/sandbox/dist`. Then build `<BASE>` in a temporary worktree and measure the same way:

```bash
git worktree add <scratchpad>/wt-sp2-base 30d41161
cd <scratchpad>/wt-sp2-base && bun install --frozen-lockfile && VITE_NETWORKS=paseo-next-v2,previewnet bun run build
bun scripts/eager-path-size.ts apps/host/dist
bun scripts/eager-path-size.ts apps/sandbox/dist
```

Expected: host `gz` does not grow (it should shrink, since the chat panel code leaves the startup path); sandbox unchanged within ±50 B. Run the sourcemap `sources` check from the SP1 Task 9 procedure (every eager chunk: no `solid-js`, `@solidjs`, or `/components/` source; for a chunk with no `.map`, grep its raw text and say so). Record the chat chunk: the chunk whose sourcemap `sources` contain `components/chat/mount.tsx`, measured with `wc -c` and `gzip -c <file> | wc -c`. If the host startup bundle grew, stop and report the chunks that grew.

- [ ] **Step 3: Cold-start A/B, 20 runs each**

Copy `apps/host/tests/performance/results/base.json` to `<scratchpad>/base.pre-sp2-ab.json` first. Then, from the worktree (before) and the branch (after), back to back, killing port 5173 before each run and running each Playwright command in the background with a log:

```bash
cd <scratchpad>/wt-sp2-base/apps/host
PERF_RUNS=20 PERF_SAVE_BASE=1 PERF_DOMAIN_A=browse PERF_DOMAIN_B=host-playground npx playwright test --config=tests/performance/playwright.config.ts tests/performance/cold-start.spec.ts
cp tests/performance/results/base.json <repo>/apps/host/tests/performance/results/base.json
cd <repo> && VITE_NETWORKS=paseo-next-v2,previewnet bun run build && cd apps/host
PERF_RUNS=20 PERF_DOMAIN_A=browse PERF_DOMAIN_B=host-playground npx playwright test --config=tests/performance/playwright.config.ts tests/performance/cold-start.spec.ts
bun tests/performance/compare.ts
```

Expected: branch `Host total` p50 no more than 5% above the worktree's. Remove the worktree afterwards and confirm `git worktree list` shows only the main checkout.

- [ ] **Step 4: Record the results**

Append to `docs/perf/solid-migration-baseline.md`:

```markdown
## After sub-project 2 (chat)

The chat panel's contents are Solid components in a lazily loaded chunk,
prefetched when the chat button first appears. Measured on
`feat/solid-v2-foundation` at `<HEAD short hash>` against the branch before
sub-project 2 (`30d41161`), same build command, eager path via
`bun scripts/eager-path-size.ts`.

| Eager path | Before SP2 gzip | After SP2 gzip | Δ gzip | Gate |
|---|---:|---:|---:|---|
| host | <B> | <B> | <±B> | no increase: <pass/fail> |
| sandbox | <B> | <B> | <±B> | unchanged: <pass/fail> |

Solid in startup chunks (sourcemap `sources`): <none / list>.

Chat chunk (hash from the measurement build): host `<file>` <raw> B raw / <gzip> B gzip.

Cold start (20 runs each, back to back): before p50 <ms>, after p50 <ms>,
Δ <±x.x%>; `compare.ts` End-to-end <z>, <significant / not significant>.
Gate (no regression beyond 5%): **<pass / fail>**.
```

Fill every `<…>`, then:

```bash
git add docs/perf/solid-migration-baseline.md
git commit -m "docs(perf): record sub-project 2 sizes and cold start"
```

- [ ] **Step 5: Final checks**

Run: `bun run typecheck && bun run lint && bun run test && bunx prettier --check $(git diff --name-only 30d41161..HEAD -- '*.ts' '*.tsx')`
Expected: all pass.
