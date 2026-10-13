// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { ChatMessageRecord } from '../../runtime/chat/store.js';
import { MessageBubble } from './MessageBubble.js';
import type { ChatMessageActions } from './chat.js';
import { CustomMessage } from './CustomMessage.js';

/**
 * One message of the conversation: the bubble, with its action taps sent to the product and a custom body rendered
 * live by the product while the row is in view.
 */
export function MessageRow(props: {
  chat: ChatMessageActions;
  record: ChatMessageRecord;
  now: number;
  onActionError: () => void;
}): JSX.Element {
  // Records are immutable and rows are keyed by seq, so an untracked one-time read is intentional.
  const record = untrack(() => props.record);
  const chat = untrack(() => props.chat);

  return (
    <MessageBubble
      record={record}
      now={props.now}
      onAction={actionId => {
        void chat
          .triggerAction(record.productId, record.roomId, { messageId: record.messageId, actionId })
          .catch(() => {
            props.onActionError();
          });
      }}
      custom={body => (
        <CustomMessage
          chat={chat}
          productId={record.productId}
          roomId={record.roomId}
          messageId={record.messageId}
          messageType={body.messageType}
          payload={body.payload}
        />
      )}
    />
  );
}
