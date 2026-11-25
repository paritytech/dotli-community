// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { onSettled, useContext, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { ChatIcon } from '@dotli/ui/icons';
import { ActionItem, ActionsContext, Chip, IconButton } from '@dotli/ui';
import { TOPBAR_PRIORITY } from '../page/index.js';
import { CHAT_PANEL_ID } from './chatPanelId.js';
import s from './ChatButton.module.css';

export type ChatButtonProps = {
  /** Chat is available to this session in this product. */
  visible: Accessor<boolean>;
  /** The chat panel is open. */
  open: Accessor<boolean>;
  /** The unread count as shown, undefined while there is none to show (the panel is open or nothing is unread). */
  unread: Accessor<string | undefined>;
  onToggle: () => void;
  /** Takes what finds the control the panel returns focus to, and returns the hand back. */
  handOver?: ((trigger: () => HTMLElement | undefined) => () => void) | undefined;
  /** Where focus goes back to while the button is not on show, such as the More button of a bar it collapsed into. */
  fallbackFocus?: (() => HTMLElement | undefined) | undefined;
};

/**
 * The topbar's button for the chat panel.
 * The unread count shows only while the panel is closed, since the room rows carry their own. It hands itself over as
 * where the panel returns focus, or `fallbackFocus` while this button is not on show.
 */
export function ChatButton(props: ChatButtonProps): JSX.Element {
  let button: HTMLButtonElement | undefined;

  // A bar that collapsed the button keeps it laid out but hidden, so it could not take focus. Safari 17.4 knows only
  // the older name of the option.
  function findTrigger(): HTMLElement | undefined {
    return button?.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true }) === false
      ? props.fallbackFocus?.()
      : button;
  }
  onSettled(() => props.handOver?.(findTrigger));

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
      aria-controls={CHAT_PANEL_ID}
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
