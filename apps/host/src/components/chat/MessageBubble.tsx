// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Product text only ever lands as JSX text, so it cannot inject markup.

import { For, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { ChatMessageContent, HexString } from '@parity/truapi';
import { InlineActionButton } from './InlineActionButton.js';
import type { ChatMessageRecord } from '../../runtime/chat/createChatStore.js';
import { relativeTime } from './relativeTime.js';
import s from './MessageBubble.module.css';

/** A custom message's product-defined body, which the page renders into the bubble. */
export type CustomBody = {
  messageType: string;
  /** Stored product-defined payload, hex-encoded. */
  payload: HexString;
};

export function MessageBubble(props: {
  record: ChatMessageRecord;
  now: number;
  /** A tap on one of an actions message's buttons. */
  onAction: (actionId: string) => void;
  /** Renders a custom message's body, before the timestamp. */
  custom: (body: CustomBody) => JSX.Element;
}): JSX.Element {
  // Records are immutable and rows are keyed by seq, so an untracked one-time read is intentional.
  const record = untrack(() => props.record);
  const content = record.content as ChatMessageContent;

  const time = (
    <time
      class={s['time']}
      data-testid="chat-msg-time"
      data-timestamp={String(record.timestamp)}
      title={new Date(record.timestamp).toLocaleString()}
    >
      {relativeTime(record.timestamp, props.now)}
    </time>
  );

  const wrap = (look: 'message' | 'event' | 'custom', body: JSX.Element): JSX.Element => (
    <div class={s['bubble']} data-testid="chat-msg-bubble" data-look={look}>
      {body}
      {time}
    </div>
  );

  // Reactions and kinds this page does not know read as events beside the conversation.
  const bubble = (): JSX.Element => {
    switch (content.tag) {
      case 'Text':
        return wrap('message', content.value.text);
      case 'RichText': {
        const count = content.value.media.length;
        return wrap(
          'message',
          <>
            {content.value.text ?? ''}
            <Show when={count > 0}>
              <span class={s['meta']} data-testid="chat-msg-meta">
                {` [${String(count)} attachment${count === 1 ? '' : 's'}]`}
              </span>
            </Show>
          </>,
        );
      }
      case 'Reaction':
        return wrap('event', `reacted ${content.value.emoji}`);
      case 'ReactionRemoved':
        return wrap('event', `removed reaction ${content.value.emoji}`);
      case 'File':
        return wrap('message', `[file] ${content.value.fileName}`);
      case 'Actions':
        return wrap(
          'message',
          <>
            <Show when={content.value.text !== undefined && content.value.text !== ''}>
              <span>{content.value.text}</span>
            </Show>
            <div
              class={s['actions']}
              data-testid="chat-msg-actions"
              data-layout={content.value.layout === 'Grid' ? 'grid' : 'column'}
            >
              <For each={content.value.actions}>
                {action => (
                  <InlineActionButton
                    variant="secondary"
                    testId="chat-msg-action"
                    onClick={() => {
                      props.onAction(action.actionId);
                    }}
                  >
                    {action.title}
                  </InlineActionButton>
                )}
              </For>
            </div>
          </>,
        );
      case 'Custom':
        return wrap('custom', props.custom({ messageType: content.value.messageType, payload: content.value.payload }));
      default:
        return wrap('event', '[unsupported message]');
    }
  };

  return (
    <div class={s['row']} data-testid="chat-msg" data-author={record.author}>
      {bubble()}
    </div>
  );
}
