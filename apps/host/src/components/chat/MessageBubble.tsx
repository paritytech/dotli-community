// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Product text only ever lands as JSX text, so it cannot inject markup.

import { For, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { ChatMessageContent, HexString } from '@parity/truapi';
import { InlineActionButton } from './InlineActionButton.js';
import type { ChatMessageRecord } from '../../runtime/chat/store.js';
import { relativeTime } from './relative-time.js';
import s from './MessageBubble.module.css';

/** A custom message's product-defined body, which the page renders into the bubble. */
export interface CustomBody {
  messageType: string;
  /** Stored product-defined payload, hex-encoded. */
  payload: HexString;
}

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

  const bubble = (): JSX.Element => {
    switch (content.tag) {
      case 'Text':
        return (
          <div class={s['bubble']} data-testid="chat-msg-bubble">
            {content.value.text}
            {time}
          </div>
        );
      case 'RichText': {
        const count = content.value.media.length;
        return (
          <div class={s['bubble']} data-testid="chat-msg-bubble">
            {content.value.text ?? ''}
            <Show when={count > 0}>
              <span class={s['meta']} data-testid="chat-msg-meta">
                {` [${String(count)} attachment${count === 1 ? '' : 's'}]`}
              </span>
            </Show>
            {time}
          </div>
        );
      }
      case 'Reaction':
        return (
          <div class={s['bubble']} data-testid="chat-msg-bubble" data-event="">
            {`reacted ${content.value.emoji}`}
            {time}
          </div>
        );
      case 'ReactionRemoved':
        return (
          <div class={s['bubble']} data-testid="chat-msg-bubble" data-event="">
            {`removed reaction ${content.value.emoji}`}
            {time}
          </div>
        );
      case 'File':
        return (
          <div class={s['bubble']} data-testid="chat-msg-bubble">
            {`[file] ${content.value.fileName}`}
            {time}
          </div>
        );
      case 'Actions':
        return (
          <div class={s['bubble']} data-testid="chat-msg-bubble">
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
            {time}
          </div>
        );
      case 'Custom':
        return (
          <div class={s['bubble']} data-testid="chat-msg-bubble" data-custom="">
            {props.custom({ messageType: content.value.messageType, payload: content.value.payload })}
            {time}
          </div>
        );
      default:
        return (
          <div class={s['bubble']} data-testid="chat-msg-bubble" data-event="">
            [unsupported message]
            {time}
          </div>
        );
    }
  };

  return (
    <div class={s['row']} data-testid="chat-msg" data-author={record.author}>
      {bubble()}
    </div>
  );
}
