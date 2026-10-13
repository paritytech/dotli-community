// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The chat panel's contents. The host's chat dock owns the panel element.

import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onSettled,
  Show,
  untrack,
} from 'solid-js';
import type { JSX } from '@solidjs/web';
import { ChevronLeftIcon, CloseIcon, SendIcon } from '@dotli/ui/icons';
import { ContactRow } from './ContactRow.js';
import { ResizeHandle } from './ResizeHandle.js';
import { MessageRow } from './MessageRow.js';
import type { ChatConversation } from './chat.js';
import { contactEntries, type ContactEntry } from './contacts.js';
import s from './ChatPanel.module.css';

// Relative bubble timestamps go stale while the panel sits open.
const TIME_REFRESH_MS = 60_000;

type View = 'loading' | 'empty' | 'list' | 'conversation';

// Within this many px of the end, the reader counts as at the newest message.
const STICK_THRESHOLD_PX = 24;

const READ_ERROR = 'Chat could not be loaded.';

function PanelBody(props: { conversation: ChatConversation; onClose: () => void }): JSX.Element {
  // The binding is fixed for the panel's life.
  const chat = untrack(() => props.conversation);
  const feed = chat.openFeed();
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

  // A keyed list moves rows with insertBefore, which blurs them. The feed notifies before Solid renders, so the
  // focused row is noted while it still has focus.
  onCleanup(
    feed.onChange(() => {
      refocusRoomId = null;
      for (const [roomId, el] of rowEls) {
        if (el === document.activeElement) {
          refocusRoomId = roomId;
        }
      }
    }),
  );

  const contacts = createMemo((): ContactEntry[] | null => {
    const shown = feed.contacts();
    return shown === null ? null : contactEntries(shown.rooms, shown.bots, shown.lastMessageTimes);
  });

  const activeContact = createMemo(() => {
    const id = chat.activeRoomId();
    return id === null ? undefined : contacts()?.find(c => c.id === id);
  });

  // A room that is not in the list yet shows the list, so its messages are not read either.
  // eslint-disable-next-line solid/reactivity -- the feed tracks the shown room in an effect of its own.
  feed.follow(() => activeContact()?.id ?? null);

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
      const id = chat.activeRoomId();
      return list !== null && id !== null && !list.some(c => c.id === id);
    },
    stale => {
      if (stale) {
        chat.roomGone();
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

  // Whether the reader is at the newest message. Growth never clears it, so a reader at the bottom stays there.
  let stuck = true;
  // Chromium fires a scroll for a resize before the ResizeObserver runs, with the end briefly out of reach, so only
  // the reader moving up the conversation leaves the newest message.
  let lastScrollTop = 0;

  const stickToBottom = (): void => {
    if (stuck && messagesEl !== undefined) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
      // Scroll events coalesce, so the reader's next move is measured from this pin.
      lastScrollTop = messagesEl.scrollTop;
    }
  };

  const focusComposerIfAsked = (): void => {
    if (inputEl !== undefined && chat.claimComposerFocus()) {
      inputEl.focus();
    }
  };

  createEffect(
    () => activeContact()?.id,
    () => {
      stuck = true;
      focusComposerIfAsked();
    },
  );

  createEffect(feed.messages, () => {
    stickToBottom();
    focusComposerIfAsked();
  });

  // Follows late growth too, such as custom trees, images, web fonts or a resized window. No feature check, as every
  // browser the build targets has ResizeObserver.
  onSettled(() => {
    if (messagesEl === undefined || threadEl === undefined) {
      return;
    }
    const resize = new ResizeObserver(stickToBottom);
    resize.observe(messagesEl);
    resize.observe(threadEl);
    return () => {
      resize.disconnect();
    };
  });

  const title = (): string => activeContact()?.name ?? chat.productName() ?? 'Chat';

  const hint = (): string | null => {
    const v = view();
    if (feed.contactsFailed() || (v === 'conversation' && feed.messagesFailed())) {
      return READ_ERROR;
    }
    if (v === 'empty') {
      return chat.loggedIn() ? 'Waiting for the app to start a chat.' : 'Log in to chat with this app.';
    }
    return v === 'conversation' ? chat.composerError() : null;
  };

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const roomId = chat.activeRoomId();
    const text = inputEl?.value.trim() ?? '';
    if (roomId === null || text === '') {
      return;
    }
    if (inputEl !== undefined) {
      inputEl.value = '';
    }
    // Sending shows the sent message, even to a reader scrolled up.
    stuck = true;
    try {
      await chat.send(roomId, text);
      chat.setComposerError(null);
    } catch (error) {
      chat.setComposerError(
        error instanceof Error && error.message.includes('denied')
          ? 'Log in to chat with this app.'
          : 'Message saved, but the app could not be reached.',
      );
    }
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
          onClick={() => {
            chat.backToRooms();
          }}
        >
          <ChevronLeftIcon />
        </button>
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
            props.onClose();
          }}
        >
          <CloseIcon size={14} />
        </button>
      </div>
      {/* role="list" again because Safari drops it from a list without bullets. */}
      <ul class={s['rooms']} id="chat-panel-rooms" role="list" aria-label="Chat rooms" hidden={view() !== 'list'}>
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
                  id={id}
                  name={contact().name}
                  icon={contact().icon}
                  unread={chat.unreadByRoom()[id] ?? 0}
                  onOpen={chat.openRoom}
                />
              );
            }}
          </For>
        </Show>
      </ul>
      <div
        class={s['messages']}
        id="chat-panel-messages"
        role="log"
        aria-label="Messages"
        // Focusable so a keyboard can scroll the conversation.
        tabindex="0"
        hidden={view() !== 'conversation'}
        ref={el => {
          messagesEl = el;
        }}
        onScroll={event => {
          const el = event.currentTarget;
          const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
          stuck = atEnd || (stuck && el.scrollTop >= lastScrollTop);
          lastScrollTop = el.scrollTop;
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
            <For each={feed.messages() ?? []} keyed={r => r.seq}>
              {record => (
                <MessageRow
                  chat={chat.actions}
                  record={record()}
                  now={now()}
                  onActionError={() => {
                    chat.setComposerError('The app could not be reached.');
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
        <button type="submit" class={s['send']} id="chat-panel-send" title="Send" aria-label="Send">
          <SendIcon />
        </button>
      </form>
    </>
  );
}

export interface ChatPanelProps {
  open: Accessor<boolean>;
  /** In px, which a drag on the panel's edge starts from. */
  width: Accessor<number>;
  onClose: () => void;
  /** The width a drag on the edge asks for, before any clamp. */
  onResize: (width: number) => void;
  /** The drag ended, so the width can be kept. */
  onResizeEnd: () => void;
  conversation: ChatConversation;
}

export function ChatPanel(props: ChatPanelProps): JSX.Element {
  return (
    <>
      <ResizeHandle
        id="chat-panel-resize"
        width={props.width}
        onResize={props.onResize}
        onResizeEnd={props.onResizeEnd}
      />
      <Show when={props.open()}>
        <PanelBody conversation={props.conversation} onClose={props.onClose} />
      </Show>
    </>
  );
}
