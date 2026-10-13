// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { ContactIcon } from './ContactIcon.js';
import { chatUnreadLabel } from './unread.js';
import s from './ContactRow.module.css';

/** One room or bot of a contact list, with its unread count. Reports the choice by the contact's id. */
export function ContactRow(props: {
  id: string;
  name: string;
  /** The product-supplied icon, empty for none. */
  icon: string;
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
        <span class={s['roomName']} data-testid="chat-room-name">
          {props.name}
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
    </li>
  );
}
