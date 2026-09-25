# Solid v2 migration — sub-project 2: chat

Status: written while the owner was AFK (2026-09-25), under their standing
instruction to continue without approval stops and record every decision in
`SOLID_MIGRATION_QUESTIONS.md`. The decisions below marked **(AFK)** are the
controller's and are listed there for review. Parent:
`2026-09-25-solid-v2-ui-migration-design.md`. Builds on sub-project 0 (stores,
`useStore`, `mountRoot`) and sub-project 1 (lazy Solid chunk pattern,
`overlays/load.ts`).

## Goal

Render the docked product-chat panel with Solid components in a lazily loaded
chunk. The panel's internal markup leaves `apps/host/index.html`. Behaviour,
markup classes, ids that tests or CSS rely on, copy and the product-content
security model are unchanged.

## Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Loading **(AFK)** | Lazy, like sub-project 1. The Solid chat chunk is imported the first time the panel opens, and prefetched when the browser is idle once the chat button becomes visible. The chat panel code (`panel.ts` rendering, `custom-renderer.ts`, `custom-message.ts`) leaves the host startup bundle, so the host startup path shrinks |
| 2 | What stays eager **(AFK)** | A Solid-free controller: the chat-panel state store, the window-event wiring, the topbar button / more-row / unread badge (still static markup until sub-project 4), and the product-iframe width write. `chat/service.ts`, `state/chat.ts` and `shared/chat-capability.ts` are unchanged |
| 3 | Markup **(AFK)** | `aside#chat-panel` stays in `index.html` as an empty container (its `class`, `role`, `aria-label`, `hidden`); every child moves into components. The button, badge and more-row stay in `index.html` (they belong to the topbar, sub-project 4) |
| 4 | Custom messages **(AFK)** | `custom-renderer.ts` and `custom-message.ts` are reused unchanged and mounted through a ref. They are the security boundary for product-drawn content (closed token vocabulary, text via text nodes) and the umbrella lists the chat IntersectionObserver as staying imperative |
| 5 | Data **(AFK)** | Components keep reading rooms, bots and messages through `chat/service.ts`'s async getters, re-reading when `chatStore` version counters or the panel state change, with today's "newer read wins" guard. No room/message cache is added to a store |
| 6 | Iframe geometry | Stays as today (`#app iframe` width written by the controller) until `product-frame-layout.ts` in sub-project 4 |
| 7 | Accessibility | No new behaviour beyond today's (Escape closes and returns focus to the button; the list keeps `role="list"`; messages keep `aria-live="polite"`). The panel is not a modal, so no focus trap |

## Scope

In: `packages/ui/src/chat/panel.ts` (becomes the controller), the panel
children in `apps/host/index.html`, new `packages/ui/src/state/chat-panel.ts`,
new `packages/ui/src/chat/load.ts`, new components under
`packages/ui/src/components/chat/`, tests.

Out: `chat/service.ts`, `chat/custom-renderer.ts`, `chat/custom-message.ts`,
`state/chat.ts`, `shared/chat-capability.ts`, `host-callbacks/Chat.ts`,
`bridge.ts`, CSS, the topbar button markup.

## Architecture

### Solid-free layer (eager)

`state/chat-panel.ts`:

```ts
interface ChatPanelState {
  label: string | null;
  runtimeProductId: string | null;
  available: boolean;
  loggedIn: boolean;
  open: boolean;
  activeRoomId: string | null;      // null = room list
  unreadByRoom: Readonly<Record<string, number>>;
  composerError: string | null;
  focusComposer: boolean;           // one-shot after picking a room
  width: number;                    // clamped 280..560, default 360, persisted
  topbarVisible: boolean;
}
```

Exports `chatPanelStore`, `currentChatProductId(state)`,
`chatButtonVisible(state)`, `totalChatUnread(state)`, and the setters the
components and controller call: `setChatPanelOpen`, `openChatRoom`,
`backToChatRooms`, `setChatComposerError`, `consumeComposerFocus`,
`markChatRoomSeen`, `setChatPanelWidth` (persists to `dotli:chat-panel-width`),
plus `initChatPanelState()` which installs today's window listeners
(`dotli:chat-availability`, `dotli:product-loaded`, `dotli:product-error`,
`dotli:truapi-auth-state` Connected/Disconnected only, `dotli:chat-message`,
`topbar:visibility`) with today's rules: a label change resets the active room,
unread counts and composer error; a product message outside the viewed room
increments that room's unread; the panel closes when the button becomes
invisible.

`chat/panel.ts` keeps `initChatPanel(): void` (called from `initTopBar`). It
calls `initChatPanelState()`, binds `#chat-button`, `#more-row-chat` and
`#chat-unread-badge` to the store (hidden, `aria-expanded`, `.active`, badge
text "9+" rule, badge hidden while open), toggles the panel on button click,
shows or hides `aside#chat-panel` and sets its width and `.topbar-hidden`,
writes the `#app iframe` width (`calc(100vw - <panel.offsetWidth>px)` when
open, `100%` when closed), calls `ensureChatPanel()` on first open, and
`prefetchChatPanel()` once the button first becomes visible.

`chat/load.ts`: `ensureChatPanel()` (memoized dynamic import of
`components/chat/mount.tsx`, never rejects; on failure reports
`chat_panel_load_error` to Sentry, closes the panel and retries on the next
open) and `prefetchChatPanel()` (idle callback, 2 s timeout fallback).

### Solid chunk (lazy)

`components/chat/mount.tsx` mounts `<ChatPanel/>` into `aside#chat-panel` via
`mountRoot("chat", …)` with `onError` closing the panel.

Components, emitting today's markup (ids and classes from `index.html` and
`panel.ts`): `ChatPanel` (resize handle `#chat-panel-resize` with pointer
capture and width clamp, header with `#chat-panel-back` / `#chat-panel-title` /
`#chat-panel-close`, `#chat-panel-rooms` `role="list"`, `#chat-panel-messages`
`aria-live="polite"`, `#chat-panel-hint`, form `#chat-panel-composer` with
`#chat-panel-input` `maxlength="4000"` and `#chat-panel-send`),
`ContactList` (`button.chat-room-item[role=listitem]`, recency order: last
message time, else creation time), `ContactIcon` (`img` with `alt=""` and an
error fallback to the uppercase initial, `-fallback` class), `Conversation`
(message rows, hard scroll to bottom after each render, composer focus once
after picking a room), `MessageBubble` (every `ChatMessageContent` tag as
today, text only via JSX text, `Actions` buttons publishing
`userTriggerAction`, `Custom` mounting `mountCustomMessage` in a ref and
disposing it on cleanup), and relative timestamps driven by a `now` signal
that ticks every 60 s while the panel is open.

Title: the active root manifest's display name, else the label, else "Chat";
the contact name while a conversation is open. Empty state hint: "Waiting for
the app to start a chat." when logged in, "Log in to chat with this app."
otherwise. Composer errors keep today's copy ("Log in to chat with this app."
for denied, "Message saved, but the app could not be reached." otherwise, "The
app could not be reached." for a failed action).

## Error handling

- Chunk import failure: Sentry `chat_panel_load_error`, the panel closes, the
  next open retries.
- Render error: `mountRoot` reports it; `onError` closes the panel.
- Custom message failures keep `custom-message.ts`'s own placeholder.

## Testing

- `state/chat-panel` unit tests: every listener rule above, unread counting,
  label reset, width clamp and persistence, button visibility.
- Controller tests (`chat-panel.test.ts` rewritten): button / more-row / badge
  state, open and close, iframe width, lazy mount on first open, Escape returns
  focus to the button. The fixture contains only the button, badge, more-row,
  empty `aside#chat-panel` and `#app iframe`, matching `index.html` after this
  sub-project.
- Component tests: contact ordering and unread pills, conversation rendering
  for each message tag, Actions buttons, custom message mount and dispose,
  composer submit and error copy, empty-state hint, resize clamp.
- `chat-custom-renderer.test.ts` and `state/chat.test.ts` unchanged.
- Playwright: none added; chat needs a logged-in session (recorded as a gap in
  the questions file). The functional suite must still pass.

## Performance gates

| Metric | Gate |
|---|---|
| Host startup bundle gzip | no increase (expected to shrink); record the delta |
| Sandbox startup bundle | unchanged |
| Solid in startup chunks | none |
| Chat chunk | size recorded |
| Cold start (20 runs A/B against the branch before sub-project 2) | no regression beyond 5% |

## Done when

- The panel renders from the lazy chat chunk; `aside#chat-panel` has no static
  children; the old DOM-building code in `panel.ts` is gone.
- Behaviour listed above is covered by tests that pass, with typecheck, lint,
  format and the functional suite.
- Gates pass and are recorded in `docs/perf/solid-migration-baseline.md`.
