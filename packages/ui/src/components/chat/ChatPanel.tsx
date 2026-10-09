// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The chat panel's contents. ChatDock owns the panel element and the product frame width.

import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { captureException, recordExpected } from '@dotli/metrics';
import { isExpectedDbError } from '@dotli/storage';
import { getActiveRootManifest } from '@dotli/shared';
import {
  chatBots,
  chatLatestMessageTimes,
  chatMessages,
  chatRooms,
  userPostMessage,
  type ChatMessageRecord,
} from '../../chat/service.js';
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
} from '../../state/chat-panel.js';
import { useStore } from '../use-store.js';
import { CloseIcon } from '../primitives/IconButton.js';
import { ContactIcon } from './ContactIcon.js';
import { contactEntries, type ContactEntry } from './contacts.js';
import { MessageBubble } from './MessageBubble.js';
import { ResizeHandle } from './ResizeHandle.js';
import s from './ChatPanel.module.css';

// Relative bubble timestamps go stale while the panel sits open.
const TIME_REFRESH_MS = 60_000;

const BACK_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';
const SEND_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/></svg>';

type View = 'loading' | 'empty' | 'list' | 'conversation';

// Within this many px of the end, the reader counts as at the newest message.
const STICK_THRESHOLD_PX = 24;

const READ_ERROR = 'Chat could not be loaded.';

function ContactRow(props: {
  contact: ContactEntry;
  unread: number;
  ref: (el: HTMLButtonElement) => void;
}): JSX.Element {
  return (
    <button
      ref={props.ref}
      type="button"
      class={s['roomItem']}
      data-testid="chat-room-item"
      role="listitem"
      onClick={() => {
        openChatRoom(props.contact.id);
      }}
    >
      <ContactIcon name={props.contact.name} icon={props.contact.icon} />
      <span class={s['roomName']} data-testid="chat-room-name">
        {props.contact.name}
      </span>
      <Show when={props.unread > 0}>
        <span
          class={s['roomUnread']}
          data-testid="chat-room-unread"
          aria-label={`${String(props.unread)} unread message${props.unread === 1 ? '' : 's'}`}
        >
          {chatUnreadLabel(props.unread)}
        </span>
      </Show>
    </button>
  );
}

function totalSeq(roomSeq: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const seq of Object.values(roomSeq)) {
    total += seq;
  }
  return total;
}

function PanelBody(): JSX.Element {
  // Slices, so a width drag, a topbar toggle or the composer-focus flag never re-runs the rows below.
  const productId = useStore(chatPanelStore, currentChatProductId);
  const loggedIn = useStore(chatPanelStore, state => state.loggedIn);
  const label = useStore(chatPanelStore, state => state.label);
  const activeRoomId = useStore(chatPanelStore, state => state.activeRoomId);
  const unreadByRoom = useStore(chatPanelStore, state => state.unreadByRoom);
  const roomSeq = useStore(chatPanelStore, state => state.roomSeq);
  const contactsVersion = useStore(chatPanelStore, state => state.contactsVersion);
  const composerError = useStore(chatPanelStore, state => state.composerError);
  const [contacts, setContacts] = createSignal<ContactEntry[] | null>(null);
  const [messages, setMessages] = createSignal<ChatMessageRecord[]>([]);
  // Separate, so each clears on its own read and a conversation error never shows over the list.
  const [contactsError, setContactsError] = createSignal(false);
  const [messagesError, setMessagesError] = createSignal(false);
  const [refresh, setRefresh] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  let messagesEl: HTMLDivElement | undefined;
  /** Wraps the bubbles, so its height is the conversation's. */
  let threadEl: HTMLDivElement | undefined;
  let inputEl: HTMLInputElement | undefined;
  // Room rows by room id, to put focus back on a row the list moved.
  const rowEls = new Map<string, HTMLButtonElement>();
  let refocusRoomId: string | null = null;

  const timer = setInterval(() => {
    setNow(Date.now());
  }, TIME_REFRESH_MS);
  onCleanup(() => {
    clearInterval(timer);
  });

  const failedRead = (
    error: unknown,
    step: 'chat_contacts_read' | 'chat_messages_read',
    setError: (on: boolean) => void,
  ): void => {
    if (isExpectedDbError(error)) {
      recordExpected(error, { flow: 'chat', step });
    } else {
      captureException(error, { flow: 'chat', step, tags: { kind: 'chat_panel_read_error' } });
    }
    setError(true);
  };

  const activeContact = createMemo(() => {
    const id = activeRoomId();
    return id === null ? undefined : contacts()?.find(c => c.id === id);
  });

  // Messages reorder the list, but it re-reads for them only while it shows, and once on return if any arrived.
  const messageCount = createMemo(() => totalSeq(roomSeq()));
  const listMessageCount = createMemo<number>(previous =>
    activeContact() === undefined || previous === undefined ? messageCount() : previous,
  );

  // A newer read or the panel closing drops an older read that resolves late.
  const contactsKey = createMemo(() => {
    const id = productId();
    return id === null
      ? null
      : `${id}\u0000${String(loggedIn())}\u0000${String(contactsVersion())}\u0000${String(listMessageCount())}`;
  });
  createEffect(contactsKey, key => {
    const id = currentChatProductId(chatPanelStore.get());
    if (key === null || id === null) {
      return;
    }
    let live = true;
    Promise.all([chatRooms(id), chatBots(id), chatLatestMessageTimes(id)])
      .then(([rooms, bots, times]) => {
        if (!live) {
          return;
        }
        // A keyed list moves rows with insertBefore, which blurs them, so note the focused row.
        refocusRoomId = null;
        for (const [roomId, el] of rowEls) {
          if (el === document.activeElement) {
            refocusRoomId = roomId;
          }
        }
        setContactsError(false);
        setContacts(contactEntries(rooms, bots, times));
      })
      .catch((error: unknown) => {
        if (live) {
          failedRead(error, 'chat_contacts_read', setContactsError);
        }
      });
    return () => {
      live = false;
    };
  });

  // Refocus the row a move blurred.
  createEffect(contacts, () => {
    const roomId = refocusRoomId;
    refocusRoomId = null;
    const el = roomId === null ? undefined : rowEls.get(roomId);
    if (el !== undefined && document.activeElement !== el) {
      el.focus();
    }
  });

  createEffect(
    () => {
      const list = contacts();
      const id = activeRoomId();
      return list !== null && id !== null && !list.some(c => c.id === id);
    },
    stale => {
      if (stale) {
        clearActiveChatRoom();
      }
    },
  );

  const view = createMemo((): View => {
    const list = contacts();
    if (list === null) {
      return 'loading';
    }
    if (list.length === 0) {
      return 'empty';
    }
    return activeContact() === undefined ? 'list' : 'conversation';
  });

  // A message for another room leaves this key alone, so the conversation and its live custom renders stay put.
  const messagesKey = createMemo(() => {
    const id = productId();
    const roomId = activeContact()?.id;
    return id === null || roomId === undefined
      ? null
      : `${id}\u0000${roomId}\u0000${String(roomSeq()[roomId] ?? 0)}\u0000${String(refresh())}`;
  });
  let shownRoomId: string | null = null;
  // Whether the reader is at the newest message. Growth never clears it, so a reader at the bottom stays there.
  let stuck = true;
  createEffect(messagesKey, key => {
    const current = chatPanelStore.get();
    const id = currentChatProductId(current);
    const roomId = current.activeRoomId;
    if (key === null || id === null || roomId === null) {
      shownRoomId = null;
      setMessagesError(false);
      setMessages([]);
      return;
    }
    if (roomId !== shownRoomId) {
      shownRoomId = roomId;
      stuck = true;
      setMessagesError(false);
      setMessages([]);
    }
    // The room check also drops a read for a room left this tick, before the effect re-runs.
    let live = true;
    chatMessages(id, roomId)
      .then(records => {
        if (!live || chatPanelStore.get().activeRoomId !== roomId) {
          return;
        }
        setMessagesError(false);
        setMessages(records);
        markChatRoomSeen(roomId);
      })
      .catch((error: unknown) => {
        if (live) {
          failedRead(error, 'chat_messages_read', setMessagesError);
        }
      });
    return () => {
      live = false;
    };
  });

  const stickToBottom = (): void => {
    if (stuck && messagesEl !== undefined) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  };

  createEffect(messages, () => {
    stickToBottom();
    if (chatPanelStore.get().focusComposer && inputEl !== undefined) {
      inputEl.focus();
      consumeComposerFocus();
    }
  });

  // Follows late growth too, such as custom trees, images, web fonts or a resized window.
  onSettled(() => {
    if (messagesEl === undefined || threadEl === undefined || typeof ResizeObserver === 'undefined') {
      return;
    }
    const resize = new ResizeObserver(stickToBottom);
    resize.observe(messagesEl);
    resize.observe(threadEl);
    return () => {
      resize.disconnect();
    };
  });

  const title = (): string => activeContact()?.name ?? getActiveRootManifest()?.displayName ?? label() ?? 'Chat';

  const hint = (): string | null => {
    const v = view();
    if (contactsError() || (v === 'conversation' && messagesError())) {
      return READ_ERROR;
    }
    if (v === 'empty') {
      return loggedIn() ? 'Waiting for the app to start a chat.' : 'Log in to chat with this app.';
    }
    return v === 'conversation' ? composerError() : null;
  };

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const current = chatPanelStore.get();
    const productId = currentChatProductId(current);
    const text = inputEl?.value.trim() ?? '';
    if (productId === null || current.activeRoomId === null || text === '') {
      return;
    }
    if (inputEl !== undefined) {
      inputEl.value = '';
    }
    // Sending shows the sent message, even to a reader scrolled up.
    stuck = true;
    try {
      await userPostMessage(productId, current.activeRoomId, text);
      setChatComposerError(null);
    } catch (error) {
      setChatComposerError(
        error instanceof Error && error.message.includes('denied')
          ? 'Log in to chat with this app.'
          : 'Message saved, but the app could not be reached.',
      );
    }
    setRefresh(n => n + 1);
  };

  return (
    <>
      <div class={s['header']}>
        <button
          type="button"
          class={s['headerButton']}
          id="chat-panel-back"
          title="Back to rooms"
          aria-label="Back to rooms"
          hidden={view() !== 'conversation'}
          // eslint-disable-next-line solid/no-innerhtml -- trusted SVG from host code
          innerHTML={BACK_SVG}
          onClick={() => {
            backToChatRooms();
          }}
        />
        <span class={s['title']} id="chat-panel-title">
          {title()}
        </span>
        <button
          type="button"
          class={s['headerButton']}
          id="chat-panel-close"
          title="Close chat"
          aria-label="Close chat"
          onClick={() => {
            setChatPanelOpen(false);
          }}
        >
          <CloseIcon size={14} />
        </button>
      </div>
      <div class={s['rooms']} id="chat-panel-rooms" role="list" aria-label="Chat rooms" hidden={view() !== 'list'}>
        <Show when={view() === 'list'}>
          <For each={contacts() ?? []} keyed={c => c.id}>
            {contact => {
              // Rows are keyed by id, so a row's id never changes.
              const id = untrack(() => contact().id);
              onCleanup(() => {
                rowEls.delete(id);
              });
              return (
                <ContactRow
                  ref={el => {
                    rowEls.set(id, el);
                  }}
                  contact={contact()}
                  unread={unreadByRoom()[id] ?? 0}
                />
              );
            }}
          </For>
        </Show>
      </div>
      <div
        class={s['messages']}
        id="chat-panel-messages"
        aria-live="polite"
        hidden={view() !== 'conversation'}
        ref={el => {
          messagesEl = el;
        }}
        onScroll={event => {
          const el = event.currentTarget;
          stuck = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
        }}
      >
        <div
          class={s['thread']}
          data-testid="chat-panel-thread"
          ref={el => {
            threadEl = el;
          }}
        >
          <Show when={view() === 'conversation'}>
            <For each={messages()} keyed={r => r.seq}>
              {record => (
                <MessageBubble
                  record={record()}
                  now={now()}
                  onActionError={() => {
                    setChatComposerError('The app could not be reached.');
                  }}
                />
              )}
            </For>
          </Show>
        </div>
      </div>
      <p class={s['hint']} id="chat-panel-hint" hidden={hint() === null}>
        {hint() ?? ''}
      </p>
      <form
        class={s['composer']}
        id="chat-panel-composer"
        hidden={view() !== 'conversation'}
        onSubmit={event => {
          void submit(event);
        }}
      >
        <input
          id="chat-panel-input"
          class={s['input']}
          type="text"
          placeholder="Message"
          autocomplete="off"
          maxlength="4000"
          disabled={view() !== 'conversation'}
          ref={el => {
            inputEl = el;
          }}
        />
        <button
          type="submit"
          class={s['send']}
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
  const open = useStore(chatPanelStore, state => state.open);
  return (
    <>
      <ResizeHandle />
      <Show when={open()}>
        <PanelBody />
      </Show>
    </>
  );
}
