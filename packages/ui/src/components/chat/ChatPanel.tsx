// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Contents of the docked chat panel. The panel itself (`aside#chat-panel`)
// and the product-iframe width are ChatDock's, which loads this chunk; this
// renders inside it and reads rooms, bots and messages from storage whenever
// the chat-panel store says they may have changed.

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
import { ContactIcon } from './ContactIcon.js';
import { contactEntries, type ContactEntry } from './contacts.js';
import { MessageBubble } from './MessageBubble.js';
import { ResizeHandle } from './ResizeHandle.js';
import s from './ChatPanel.module.css';

// Relative bubble timestamps go stale while the panel sits open.
const TIME_REFRESH_MS = 60_000;

const BACK_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
const CLOSE_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const SEND_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';

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
  // Slices, not the whole store: a width drag, a topbar toggle or the
  // composer-focus flag must not re-run the rows and derivations below.
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
  // Kept apart so each clears when its own read works, and a failed
  // conversation read never shows over the list.
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

  // Messages move the list's recency order, but the list is only re-read
  // for them while it shows: a memo that holds the message count from the
  // last time the list showed, so reading a conversation re-reads nothing
  // and going back re-reads once, only if messages came in meanwhile.
  const messageCount = createMemo(() => totalSeq(roomSeq()));
  const listMessageCount = createMemo<number>(previous =>
    activeContact() === undefined || previous === undefined ? messageCount() : previous,
  );

  // Contacts: re-read when the product, the session, the room and bot lists,
  // or (while the list shows) the messages change. A read acts only while it
  // is current: a newer read, or the panel closing, drops an older one that
  // resolves late.
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
        // A keyed list moves rows with insertBefore, which blurs a moved
        // row; note the focused one to focus again after the update.
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

  // After the rows move: focus the row that had it, if the move blurred it.
  createEffect(contacts, () => {
    const roomId = refocusRoomId;
    refocusRoomId = null;
    const el = roomId === null ? undefined : rowEls.get(roomId);
    if (el !== undefined && document.activeElement !== el) {
      el.focus();
    }
  });

  // The open room vanished, or there are no contacts: back to the list.
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

  // Messages of the open room: re-read when that room gets a message (its
  // roomSeq moves) or after sending. A message for another room leaves this
  // key alone, so the conversation and its live custom renders stay put.
  const messagesKey = createMemo(() => {
    const id = productId();
    const roomId = activeContact()?.id;
    return id === null || roomId === undefined
      ? null
      : `${id}\u0000${roomId}\u0000${String(roomSeq()[roomId] ?? 0)}\u0000${String(refresh())}`;
  });
  let shownRoomId: string | null = null;
  // Whether the reader is at the newest message. Only a scroll moves it, so
  // content that grows under a reader at the bottom keeps them there.
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
    // As for contacts; the room check also drops a read for a room left in
    // this same tick, before the effect re-runs (the store moves at once).
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

  // After each message render: keep a reader at the newest message there,
  // and focus the composer once after picking a room.
  createEffect(messages, () => {
    stickToBottom();
    if (chatPanelStore.get().focusComposer && inputEl !== undefined) {
      inputEl.focus();
      consumeComposerFocus();
    }
  });

  // Follow any growth while the reader is at the bottom: the thread's height
  // moves with a message added or removed, a custom tree drawn late, an
  // image or a web font that loads late, or a reflow; the list's with the
  // hint line or the window.
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
          // eslint-disable-next-line solid/no-innerhtml -- trusted SVG from host code
          innerHTML={CLOSE_SVG}
          onClick={() => {
            setChatPanelOpen(false);
          }}
        />
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
