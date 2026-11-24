// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shown room's head. It sits inside a heading, so it holds only what a heading may: a button, an image and text.

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { IconButton } from '@dotli/ui';
import { ChevronLeftIcon } from '@dotli/ui/icons';
import { ContactIcon } from './ContactIcon.js';
import type { ShownContact } from './contacts.js';
import s from './ChatHead.module.css';

type ChatHeadProps = {
  shown: ShownContact;
  /** A press on the back button, which shows only when a room list stands behind the room. */
  onBack: () => void;
};

/** The back button, avatar and name of the room the chat shows. */
export function ChatHead(props: ChatHeadProps): JSX.Element {
  return (
    <>
      <Show when={!props.shown.sole}>
        <IconButton
          id="chat-panel-back"
          size="sm"
          title="Back to rooms"
          aria-label="Back to rooms"
          onClick={() => {
            props.onBack();
          }}
        >
          <ChevronLeftIcon />
        </IconButton>
      </Show>
      <ContactIcon name={props.shown.contact.name} icon={props.shown.contact.icon} size="sm" />
      <span class={s['name']}>{props.shown.contact.name}</span>
    </>
  );
}
