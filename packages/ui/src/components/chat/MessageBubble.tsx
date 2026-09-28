// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One message row. Product text only ever lands as JSX text, so it cannot
// inject markup; custom messages go through CustomMessage.tsx, whose
// renderer maps a closed token vocabulary to DOM.

import { For, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { ChatMessageContent } from "@parity/truapi";
import { userTriggerAction, type ChatMessageRecord } from "../../chat/service";
import { CustomMessage } from "./CustomMessage";
import { relativeTime } from "./contacts";

export function MessageBubble(props: {
  record: ChatMessageRecord;
  now: number;
  onActionError: () => void;
}): JSX.Element {
  // Records are immutable and the list keys rows by seq, so read once;
  // untrack both satisfies solid/reactivity and tells Solid's dev-mode
  // strict checks this one-time snapshot is intentional.
  const record = untrack(() => props.record);
  const content = record.content as ChatMessageContent;

  const time = (
    <time
      class="chat-msg-time"
      data-timestamp={String(record.timestamp)}
      title={new Date(record.timestamp).toLocaleString()}
    >
      {relativeTime(record.timestamp, props.now)}
    </time>
  );

  const bubble = (): JSX.Element => {
    switch (content.tag) {
      case "Text":
        return (
          <div class="chat-msg-bubble">
            {content.value.text}
            {time}
          </div>
        );
      case "RichText": {
        const count = content.value.media.length;
        return (
          <div class="chat-msg-bubble">
            {content.value.text ?? ""}
            <Show when={count > 0}>
              <span class="chat-msg-meta">
                {` [${String(count)} attachment${count === 1 ? "" : "s"}]`}
              </span>
            </Show>
            {time}
          </div>
        );
      }
      case "Reaction":
        return (
          <div class="chat-msg-bubble chat-msg-event">
            {`reacted ${content.value.emoji}`}
            {time}
          </div>
        );
      case "ReactionRemoved":
        return (
          <div class="chat-msg-bubble chat-msg-event">
            {`removed reaction ${content.value.emoji}`}
            {time}
          </div>
        );
      case "File":
        return (
          <div class="chat-msg-bubble">
            {`[file] ${content.value.fileName}`}
            {time}
          </div>
        );
      case "Actions":
        return (
          <div class="chat-msg-bubble">
            <Show
              when={
                content.value.text !== undefined && content.value.text !== ""
              }
            >
              <span>{content.value.text}</span>
            </Show>
            <div
              class={`chat-msg-actions chat-msg-actions-${content.value.layout === "Grid" ? "grid" : "column"}`}
            >
              <For each={content.value.actions}>
                {(action) => (
                  <button
                    type="button"
                    class="chat-custom-btn chat-custom-btn-secondary"
                    onClick={() => {
                      void userTriggerAction(record.productId, record.roomId, {
                        messageId: record.messageId,
                        actionId: action.actionId,
                        // eslint-disable-next-line solid/reactivity -- props read at call time inside the promise callback
                      }).catch(() => {
                        props.onActionError();
                      });
                    }}
                  >
                    {action.title}
                  </button>
                )}
              </For>
            </div>
            {time}
          </div>
        );
      case "Custom":
        return (
          <div class="chat-msg-bubble chat-msg-custom">
            <CustomMessage
              productId={record.productId}
              roomId={record.roomId}
              messageId={record.messageId}
              messageType={content.value.messageType}
              payload={content.value.payload}
            />
            {time}
          </div>
        );
      default:
        return (
          <div class="chat-msg-bubble chat-msg-event">
            [unsupported message]
            {time}
          </div>
        );
    }
  };

  return (
    <div
      class={`chat-msg ${record.author === "user" ? "chat-msg-user" : "chat-msg-product"}`}
    >
      {bubble()}
    </div>
  );
}
