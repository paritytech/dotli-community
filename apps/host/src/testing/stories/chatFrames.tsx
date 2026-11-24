// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What a part of the chat sits in on the host page: the chat panel's surface, for a part shown on its own.

import type { JSX } from '@solidjs/web';
import { createJSXDecorator } from 'storybook-solidjs-vite';

/** The chat panel's surface at the drawer's width, for a part of the chat shown on its own. */
export function ChatSurface(props: { children: JSX.Element }): JSX.Element {
  return (
    <div
      data-testid="chat-surface"
      style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: 'var(--sp-hair)',
        'box-sizing': 'border-box',
        width: 'var(--w-pop-lg)',
        'max-width': '100%',
        padding: 'var(--sp-3)',
        'border-radius': 'var(--r-pop)',
        background: 'var(--chat-bg-surface-main)',
      }}
    >
      {props.children}
    </div>
  );
}

/** A story's part of the chat on the chat panel's surface. */
export const onChatSurface = createJSXDecorator(Story => (
  <ChatSurface>
    <Story />
  </ChatSurface>
));
