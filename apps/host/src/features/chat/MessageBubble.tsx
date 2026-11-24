// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Product text only ever lands as JSX text, so it cannot inject markup.

import { For, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { ChatMessageContent, HexString } from '@parity/truapi';
import { FileIcon, PaperclipIcon } from '@dotli/ui/icons';
import { InlineActionButton } from './InlineActionButton.js';
import type { ChatMessageRecord } from './createChatStore.js';
import s from './MessageBubble.module.css';

/** A custom message's product-defined body, which the page renders into the bubble. */
export type CustomBody = {
  messageType: string;
  /** Stored product-defined payload, hex-encoded. */
  payload: HexString;
};

type BubbleLook = 'message' | 'actions' | 'custom';

export function MessageBubble(props: {
  record: ChatMessageRecord;
  /** A tap on one of an actions message's buttons. */
  onAction: (actionId: string) => void;
  /** Renders a custom message's body, above the time. */
  custom: (body: CustomBody) => JSX.Element;
}): JSX.Element {
  // Records are immutable and rows are keyed by seq, so an untracked one-time read is intentional.
  const record = untrack(() => props.record);
  const content = record.content as ChatMessageContent;

  const time = (): JSX.Element => (
    <time
      class={s['time']}
      data-testid="chat-msg-time"
      data-timestamp={String(record.timestamp)}
      title={new Date(record.timestamp).toLocaleString()}
    >
      {new Date(record.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
    </time>
  );

  const bubble = (look: BubbleLook, body: JSX.Element): JSX.Element => (
    <div class={s['bubble']} data-testid="chat-msg-bubble" data-look={look}>
      <div class={s['body']}>{body}</div>
      {time()}
    </div>
  );

  const event = (text: string): JSX.Element => (
    <div class={s['event']} data-testid="chat-msg-bubble">
      {text}
      {time()}
    </div>
  );

  // Reactions and kinds this page does not know read as events beside the conversation.
  const message = (): JSX.Element => {
    switch (content.tag) {
      case 'Text':
        return bubble('message', content.value.text);
      case 'RichText': {
        const count = content.value.media.length;
        return bubble(
          'message',
          <>
            {content.value.text ?? ''}
            <Show when={count > 0}>
              <span class={s['meta']} data-testid="chat-msg-meta">
                <PaperclipIcon class={s['metaIcon']} size={14} />
                {`${String(count)} attachment${count === 1 ? '' : 's'}`}
              </span>
            </Show>
          </>,
        );
      }
      case 'Reaction':
        return event(`Reacted ${content.value.emoji}`);
      case 'ReactionRemoved':
        return event(`Removed reaction ${content.value.emoji}`);
      case 'File':
        return bubble(
          'message',
          <span class={s['file']}>
            <FileIcon class={s['fileIcon']} size={22} />
            <span class={s['fileText']}>
              <span class={s['fileName']}>{content.value.fileName}</span>
              <span class={s['fileKind']} data-testid="chat-msg-meta">
                File
              </span>
            </span>
          </span>,
        );
      case 'Actions':
        return bubble(
          'actions',
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
        return bubble(
          'custom',
          props.custom({ messageType: content.value.messageType, payload: content.value.payload }),
        );
      default:
        return event('Unsupported message');
    }
  };

  return (
    <div class={s['row']} data-testid="chat-msg" data-author={record.author}>
      {message()}
    </div>
  );
}
