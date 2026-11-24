// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { ContactIcon } from './ContactIcon.js';
import { getLastMessageLabel } from './messageDays.js';
import { chatUnreadLabel } from './unread.js';
import s from './ContactRow.module.css';

/**
 * One room of a contact list, with what it is, when its last message came and its unread count. Reports the
 * choice by the contact's id.
 */
export function ContactRow(props: {
  id: string;
  name: string;
  /** The product-supplied icon, empty for none. */
  icon: string;
  /** Whether its conversation takes no text from the user. */
  readOnly: boolean;
  /** Null until the conversation has a message. */
  lastMessageAt: number | null;
  /** The time that tells whether the last message came today. */
  now: number;
  unread: number;
  ref?: ((el: HTMLButtonElement) => void) | undefined;
  onOpen: (id: string) => void;
}): JSX.Element {
  return (
    <li class={s['room']}>
      <button
        ref={el => props.ref?.(el)}
        type="button"
        class={s['roomItem']}
        data-testid="chat-room-item"
        onClick={() => {
          props.onOpen(props.id);
        }}
      >
        <ContactIcon name={props.name} icon={props.icon} />
        <span class={s['text']}>
          <span class={s['line']}>
            <span class={s['roomName']} data-testid="chat-room-name">
              {props.name}
            </span>
            <Show when={props.lastMessageAt}>
              {at => <span class={s['time']}>{getLastMessageLabel(at(), props.now)}</span>}
            </Show>
          </span>
          <span class={s['line']}>
            <span class={s['detail']}>{props.readOnly ? 'Read only' : 'Room'}</span>
            <Show when={props.unread > 0}>
              <span
                class={s['roomUnread']}
                role="img"
                data-testid="chat-room-unread"
                aria-label={`${String(props.unread)} unread message${props.unread === 1 ? '' : 's'}`}
              >
                {chatUnreadLabel(props.unread)}
              </span>
            </Show>
          </span>
        </span>
      </button>
    </li>
  );
}
