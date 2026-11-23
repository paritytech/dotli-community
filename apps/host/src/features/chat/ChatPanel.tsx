// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The chat panel's contents, below the drawer's head that names the product and closes the panel.

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
import { ChevronLeftIcon, SendIcon } from '@dotli/ui/icons';
import { ContactRow } from './ContactRow.js';
import { MessageRow } from './MessageRow.js';
import { ChatReplyUndeliveredError } from './chatReplyUndeliveredError.js';
import type { ChatConversation } from './chat.js';
import { contactEntries, type ContactEntry } from './contacts.js';
import { endsRun } from './messageRuns.js';
import s from './ChatPanel.module.css';

// Relative bubble timestamps go stale while the panel sits open.
const TIME_REFRESH_MS = 60_000;

type View = 'loading' | 'empty' | 'list' | 'conversation';

// Within this many px of the end, the reader counts as at the newest message.
const STICK_THRESHOLD_PX = 24;

function PanelBody(props: { conversation: ChatConversation }): JSX.Element {
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

  // With one room there is no list to pick from, so that room shows.
  const soleContact = createMemo(() => {
    const list = contacts();
    return list?.length === 1 ? list[0] : undefined;
  });

  // An open room that is not in the list yet shows the list, so its messages are not read either.
  const shownContact = createMemo(() => {
    const id = chat.activeRoomId();
    return id === null ? soleContact() : contacts()?.find(c => c.id === id);
  });

  // eslint-disable-next-line solid/reactivity -- the feed tracks the shown room in an effect of its own.
  feed.follow(() => shownContact()?.id ?? null);

  // Showing the sole room opens it, so it stays open once a second room appears, and the page treats it as open.
  createEffect(
    () => (chat.activeRoomId() === null ? (soleContact()?.id ?? null) : null),
    roomId => {
      if (roomId !== null) {
        chat.openRoom(roomId);
      }
    },
  );

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
    return shownContact() === undefined ? 'list' : 'conversation';
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
    () => shownContact()?.id,
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

  // The product chose what its room shows below the messages.
  const composing = (): boolean => view() === 'conversation' && shownContact()?.footer !== 'Empty';

  const hint = createMemo((): { text: string; error: boolean } | null => {
    const v = view();
    if (feed.contactsFailed() || (v === 'conversation' && feed.messagesFailed())) {
      return { text: 'Chat could not be loaded.', error: true };
    }
    if (v === 'empty') {
      const text = chat.loggedIn() ? 'Waiting for the app to start a chat.' : 'Log in to chat with this app.';
      return { text, error: false };
    }
    if (v !== 'conversation') {
      return null;
    }
    const composerError = chat.composerError();
    if (composerError !== null) {
      return { text: composerError, error: true };
    }
    if (!composing()) {
      return { text: 'This chat is read only.', error: false };
    }
    return feed.messages()?.length === 0 ? { text: 'No messages yet.', error: false } : null;
  });

  // Mirrors the input, so Send is off while there is nothing to send.
  const [draft, setDraft] = createSignal('');
  const writeDraft = (input: HTMLInputElement, text: string): void => {
    input.value = text;
    setDraft(text);
  };

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const roomId = shownContact()?.id;
    const input = inputEl;
    if (roomId === undefined || input === undefined) {
      return;
    }
    const text = input.value.trim();
    if (text === '') {
      return;
    }
    writeDraft(input, '');
    // Sending shows the sent message, even to a reader scrolled up.
    stuck = true;
    try {
      await chat.send(roomId, text);
      chat.setComposerError(null);
    } catch (error) {
      if (error instanceof ChatReplyUndeliveredError) {
        chat.setComposerError('Message saved, but the app could not be reached.');
        return;
      }
      // Nothing was kept, so the text goes back unless the user has typed anew.
      if (input.value === '') {
        writeDraft(input, text);
      }
      chat.setComposerError('Message not sent. Try again.');
    }
  };

  return (
    <>
      <Show when={view() === 'conversation'}>
        <div class={s['header']}>
          <Show when={soleContact() === undefined}>
            <button
              type="button"
              class={s['headerButton']}
              id="chat-panel-back"
              title="Back to rooms"
              aria-label="Back to rooms"
              onClick={() => {
                chat.backToRooms();
              }}
            >
              <ChevronLeftIcon />
            </button>
          </Show>
          <span class={s['title']} id="chat-panel-title">
            {shownContact()?.name}
          </span>
        </div>
      </Show>
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
              {(record, index) => (
                <MessageRow
                  chat={chat.actions}
                  record={record()}
                  now={now()}
                  endsRun={endsRun(record(), feed.messages()?.[index() + 1])}
                  onActionError={() => {
                    chat.setComposerError('The app could not be reached.');
                  }}
                />
              )}
            </For>
          </Show>
        </div>
      </div>
      <p
        class={s['hint']}
        id="chat-panel-hint"
        data-error={hint()?.error === true ? '' : undefined}
        hidden={hint() === null}
      >
        {hint()?.text ?? ''}
      </p>
      <form
        class={s['composer']}
        id="chat-panel-composer"
        hidden={!composing()}
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
          disabled={!composing()}
          ref={el => {
            inputEl = el;
          }}
          onInput={event => {
            setDraft(event.currentTarget.value);
          }}
        />
        <button
          type="submit"
          class={s['send']}
          id="chat-panel-send"
          title="Send"
          aria-label="Send"
          disabled={draft().trim() === ''}
        >
          <SendIcon />
        </button>
      </form>
    </>
  );
}

export type ChatPanelProps = {
  open: Accessor<boolean>;
  conversation: ChatConversation;
};

export function ChatPanel(props: ChatPanelProps): JSX.Element {
  return (
    <Show when={props.open()}>
      <PanelBody conversation={props.conversation} />
    </Show>
  );
}
