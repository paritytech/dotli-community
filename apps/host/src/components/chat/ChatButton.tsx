// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, useContext, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { ChatIcon } from '@dotli/ui/icons';
import { ActionItem, ActionsContext, Chip, IconButton, focusLostOrInside, focusTrigger } from '@dotli/ui';
import { TOPBAR_PRIORITY } from '../topbar/priority.js';
import s from './ChatButton.module.css';

export interface ChatButtonProps {
  /** Chat is available to this session in this product. */
  visible: Accessor<boolean>;
  /** The docked chat panel is open. */
  open: Accessor<boolean>;
  /** The unread count as shown, undefined while there is none to show (the panel is open or nothing is unread). */
  unread: Accessor<string | undefined>;
  onToggle: () => void;
  /** The chat panel, which hands focus back here when it closes with focus inside. */
  panel: () => HTMLElement | undefined;
  /** Where focus goes back to while the button is not on show, such as the More button of a bar it collapsed into. */
  fallbackFocus?: (() => HTMLElement | undefined) | undefined;
}

/**
 * The topbar's button for the docked chat panel.
 * The unread count shows only while the panel is closed, since the room rows carry their own. When the panel
 * closes with focus inside it, focus returns here, or to `fallbackFocus` while this button is not on show.
 */
export function ChatButton(props: ChatButtonProps): JSX.Element {
  let button: HTMLButtonElement | undefined;

  let wasOpen = false;
  createEffect(
    () => props.open(),
    isOpen => {
      const closed = wasOpen && !isOpen;
      wasOpen = isOpen;
      if (!closed) {
        return;
      }
      if (focusLostOrInside(props.panel())) {
        focusTrigger(button, props.fallbackFocus?.());
      }
    },
  );

  return (
    <IconButton
      ref={el => {
        button = el;
      }}
      onClick={() => {
        props.onToggle();
      }}
      id="chat-button"
      title="Chat"
      aria-label={props.unread() === undefined ? 'Chat' : `Chat, ${String(props.unread())} unread`}
      aria-expanded={props.open() ? 'true' : 'false'}
      aria-controls="chat-panel"
      hidden={!props.visible()}
    >
      <ChatIcon />
      <span class={s['unread']} id="chat-unread-badge" hidden={props.unread() === undefined}>
        {props.unread() ?? ''}
      </span>
    </IconButton>
  );
}

/** The chat button in a bar. While the bar has collapsed the button, focus coming back from the panel goes to More. */
export function ChatItem(props: ChatButtonProps): JSX.Element {
  const bar = useContext(ActionsContext);
  return (
    <ActionItem
      name="chat"
      label="Chat"
      icon={ChatIcon}
      alert={props.unread() === undefined ? undefined : { tone: 'info', label: 'chat has unread messages' }}
      aside={props.unread() === undefined ? undefined : () => <Chip>{props.unread()}</Chip>}
      priority={TOPBAR_PRIORITY.chat}
      visible={props.visible()}
      activate={() => {
        props.onToggle();
      }}
    >
      <ChatButton {...props} fallbackFocus={() => bar?.moreButton()} />
    </ActionItem>
  );
}
