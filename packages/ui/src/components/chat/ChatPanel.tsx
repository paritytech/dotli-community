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
      if (
        pass !== messagesPass ||
        chatPanelStore.get().activeRoomId !== roomId
      ) {
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
