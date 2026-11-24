// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The chat panel's contents, below the drawer's head that names the product and closes the panel.

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  onSettled,
  Show,
  Switch,
  untrack,
} from 'solid-js';
import type { JSX } from '@solidjs/web';
import { IconButton, Spinner } from '@dotli/ui';
import { ChatIcon, ChevronLeftIcon, CircleAlertIcon, LockIcon, SendIcon } from '@dotli/ui/icons';
import { ContactIcon } from './ContactIcon.js';
import { ContactRow } from './ContactRow.js';
import { MessageRow } from './MessageRow.js';
import { ChatReplyUndeliveredError } from './chatReplyUndeliveredError.js';
import type { ChatConversation } from './chat.js';
import { contactEntries, type ContactEntry } from './contacts.js';
import { getDayLabel, startsDay } from './messageDays.js';
import { endsRun } from './messageRuns.js';
import { chatUnreadLabel } from './unread.js';
import s from './ChatPanel.module.css';

// Relative timestamps on bubbles and rows go stale while the panel sits open.
const TIME_REFRESH_MS = 60_000;

type View = 'loading' | 'empty' | 'list' | 'conversation';

/** What the panel tells the user in place of, or below, its rooms and messages. */
type Hint =
  | { kind: 'loading' | 'loggedOut' | 'noRooms' | 'failed' | 'noMessages' | 'readOnly' }
  | { kind: 'error'; text: string };

/** A hint either fills the space the rooms or messages would take, or sits at the foot above the composer. */
const HINT_PLACES = {
  loading: 'center',
  loggedOut: 'center',
  noRooms: 'center',
  failed: 'center',
  noMessages: 'center',
  readOnly: 'foot',
  error: 'foot',
} satisfies Record<Hint['kind'], 'center' | 'foot'>;

// Within this many px of the end, the reader counts as at the newest message.
const STICK_THRESHOLD_PX = 24;

export type ChatPanelProps = {
  conversation: ChatConversation;
};

/** The panel's contents. Its reads run from its mount to its unmount. */
export function ChatPanel(props: ChatPanelProps): JSX.Element {
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

  // The drawer's head names the product, so the sole room takes no head of its own.
  const headContact = createMemo(() => (soleContact() === undefined ? shownContact() : undefined));

  // What waits in the rooms going back shows. The shown room is left out, as its messages are on screen.
  const unreadElsewhere = createMemo(() => {
    const shownId = headContact()?.id;
    let total = 0;
    for (const [roomId, count] of Object.entries(chat.unreadByRoom())) {
      if (roomId !== shownId) {
        total += count;
      }
    }
    return total;
  });

  // eslint-disable-next-line solid/reactivity -- the feed tracks the shown room in an effect of its own.
  feed.follow(() => shownContact()?.id ?? null);

  // Showing the sole room opens it, so it stays open once a second room appears, and the page treats it as open.
  // The user did not pick it, so its composer leaves the keyboard down.
  createEffect(
    () => (chat.activeRoomId() === null ? (soleContact()?.id ?? null) : null),
    roomId => {
      if (roomId !== null) {
        chat.openRoom(roomId, { focusComposer: false });
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

  const conversationHint = (): Hint | null => {
    const composerError = chat.composerError();
    if (composerError !== null) {
      return { kind: 'error', text: composerError };
    }
    if (!composing()) {
      return { kind: 'readOnly' };
    }
    return feed.messages()?.length === 0 ? { kind: 'noMessages' } : null;
  };

  const hint = createMemo((): Hint | null => {
    const v = view();
    if (feed.contactsFailed() || (v === 'conversation' && feed.messagesFailed())) {
      // Only a panel with nothing to show fills with the failure. Rooms or messages read before stay in view.
      return v === 'loading' || v === 'empty'
        ? { kind: 'failed' }
        : { kind: 'error', text: 'Chat could not be loaded.' };
    }
    switch (v) {
      case 'loading':
        return { kind: 'loading' };
      case 'empty':
        return { kind: chat.loggedIn() ? 'noRooms' : 'loggedOut' };
      case 'list':
        return null;
      case 'conversation':
        return conversationHint();
    }
  });

  const hintPlace = (): string | undefined => {
    const shown = hint();
    return shown === null ? undefined : HINT_PLACES[shown.kind];
  };

  const errorText = (): string | null => {
    const shown = hint();
    return shown?.kind === 'error' ? shown.text : null;
  };

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
    <div class={s['panel']}>
      <Show when={headContact()}>
        {contact => (
          <div class={s['header']}>
            <IconButton
              id="chat-panel-back"
              title="Back to rooms"
              aria-label="Back to rooms"
              onClick={() => {
                chat.backToRooms();
              }}
            >
              <ChevronLeftIcon />
            </IconButton>
            <ContactIcon name={contact().name} icon={contact().icon} size="sm" />
            <span class={s['titles']}>
              <span class={s['title']} id="chat-panel-title">
                {contact().name}
              </span>
              <Show when={chat.productName()}>
                {name => (
                  <span class={s['subtitle']} id="chat-panel-subtitle">
                    {name()}
                  </span>
                )}
              </Show>
            </span>
            <Show when={unreadElsewhere() > 0}>
              <span
                class={s['otherUnread']}
                id="chat-panel-other-unread"
                role="img"
                title="Unread in other rooms"
                aria-label={`${String(unreadElsewhere())} unread in other rooms`}
              >
                {chatUnreadLabel(unreadElsewhere())}
              </span>
            </Show>
          </div>
        )}
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
                  kind={contact().kind}
                  name={contact().name}
                  icon={contact().icon}
                  readOnly={contact().footer === 'Empty'}
                  lastMessageAt={contact().lastMessageAt}
                  now={now()}
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
                <>
                  <Show when={startsDay(record(), feed.messages()?.[index() - 1])}>
                    <p class={s['day']} data-testid="chat-day">
                      {getDayLabel(record().timestamp, now())}
                    </p>
                  </Show>
                  <MessageRow
                    chat={chat.actions}
                    record={record()}
                    now={now()}
                    endsRun={endsRun(record(), feed.messages()?.[index() + 1])}
                    onActionError={() => {
                      chat.setComposerError('The app could not be reached.');
                    }}
                  />
                </>
              )}
            </For>
          </Show>
        </div>
      </div>
      <div class={s['hint']} id="chat-panel-hint" data-place={hintPlace()} hidden={hint() === null}>
        <Switch>
          <Match when={hint()?.kind === 'loading'}>
            <Spinner class={s['spinner']} />
            <p class={s['line']}>Loading chat</p>
          </Match>
          <Match when={hint()?.kind === 'loggedOut'}>
            <LockIcon class={s['mark']} size={28} />
            <p class={s['heading']}>Log in to chat</p>
            <p class={s['line']}>Chats with this app open once you log in.</p>
          </Match>
          <Match when={hint()?.kind === 'noRooms'}>
            <ChatIcon class={s['mark']} size={28} />
            <p class={s['heading']}>No chats yet</p>
            <p class={s['line']}>Waiting for the app to start a chat.</p>
          </Match>
          <Match when={hint()?.kind === 'failed'}>
            <CircleAlertIcon class={s['failedMark']} size={28} />
            <p class={s['heading']}>Chat could not be loaded</p>
          </Match>
          <Match when={hint()?.kind === 'noMessages'}>
            <p class={s['line']}>No messages yet.</p>
          </Match>
          <Match when={hint()?.kind === 'readOnly'}>
            <p class={s['note']}>This chat is read only.</p>
          </Match>
          <Match when={errorText()}>{text => <p class={s['error']}>{text()}</p>}</Match>
        </Switch>
      </div>
      <form
        class={s['composer']}
        id="chat-panel-composer"
        hidden={!composing()}
        onSubmit={event => {
          void submit(event);
        }}
      >
        <div class={s['field']}>
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
            <SendIcon size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}
