// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { dismissToast, removeToast, type ToastEntry } from "../../state/toasts";

export const CLOSE_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<line x1="18" y1="6" x2="6" y2="18"/>' +
  '<line x1="6" y1="6" x2="18" y2="18"/></svg>';

export function ToastCard(props: {
  entry: ToastEntry;
  hidden: boolean;
  depth: number;
}): JSX.Element {
  // The id never changes for a card (the stack keys cards by id).
  // eslint-disable-next-line solid/reactivity -- stable key, read once
  const id = props.entry.id;
  const [entering, setEntering] = createSignal(true);
  // A leaving card keeps the layout it had when it started to leave.
  const hidden = createMemo<boolean>((prev) =>
    props.entry.leaving ? (prev ?? false) : props.hidden,
  );
  const depth = createMemo<number>((prev) =>
    props.entry.leaving ? (prev ?? 0) : props.depth,
  );

  // A hidden card is display:none, so no animationend would ever arrive.
  createEffect(
    () => props.entry.leaving && hidden(),
    (removeNow) => {
      if (removeNow) {
        removeToast(id);
      }
    },
  );

  return (
    <div
      class={[
        "notif-card",
        {
          "notif-enter": entering(),
          "notif-leave": props.entry.leaving,
          "notif-hidden-card": hidden(),
        },
      ]}
      data-id={String(id)}
      style={{ "--i": String(depth()) }}
      onAnimationEnd={() => {
        if (props.entry.leaving) {
          removeToast(id);
        } else {
          setEntering(false);
        }
      }}
    >
      <div
        class="notif-icon"
        // eslint-disable-next-line solid/no-innerhtml -- trusted SVG from host code
        innerHTML={props.entry.icon}
        style={
          props.entry.iconBackground === undefined
            ? undefined
            : { background: props.entry.iconBackground }
        }
      />
      <div class="notif-text">
        <span class="notif-title">{props.entry.label}</span>
        <Show
          when={props.entry.deeplink}
          fallback={<span class="notif-body">{props.entry.text}</span>}
        >
          {(href) => (
            <a class="notif-body" href={href()} target="_blank" rel="noopener">
              {props.entry.text}
            </a>
          )}
        </Show>
      </div>
      <Show when={props.entry.action}>
        {(action) => (
          <button
            type="button"
            class="notif-action"
            onClick={(event) => {
              event.stopPropagation();
              action().onClick();
            }}
          >
            {action().label}
          </button>
        )}
      </Show>
      <button
        type="button"
        class="notif-card-close"
        data-id={String(id)}
        aria-label="Dismiss"
        // eslint-disable-next-line solid/no-innerhtml -- trusted SVG from host code
        innerHTML={CLOSE_SVG}
        onClick={(event) => {
          event.stopPropagation();
          dismissToast(id);
        }}
      />
    </div>
  );
}
