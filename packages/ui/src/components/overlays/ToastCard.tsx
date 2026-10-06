// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { dismissToast, removeToast, type ToastEntry } from '../../state/toasts.js';
import { Button } from '../primitives/Button.js';
import { CloseIcon, IconButton } from '../primitives/IconButton.js';
import s from './ToastCard.module.css';

export interface ToastCardProps {
  entry: ToastEntry;
  hidden: boolean;
  /** Place in the collapsed pile, 0 for the newest. */
  depth: number;
  expanded: boolean;
  /** The stack holds one live toast, which keeps its close button while piled. */
  single: boolean;
}

export function ToastCard(props: ToastCardProps): JSX.Element {
  // The id never changes for a card (the stack keys cards by id).
  const id = untrack(() => props.entry.id);
  const [entering, setEntering] = createSignal(true);
  // A leaving card keeps the layout it had when it started to leave.
  const hidden = createMemo<boolean>(prev => (props.entry.leaving ? (prev ?? false) : props.hidden));
  const depth = createMemo<number>(prev => (props.entry.leaving ? (prev ?? 0) : props.depth));

  // A hidden card is display:none, so no animationend would ever arrive.
  createEffect(
    () => props.entry.leaving && hidden(),
    removeNow => {
      if (removeNow) {
        removeToast(id);
      }
    },
  );

  return (
    <div
      class={[s['card'], props.expanded ? s['expanded'] : s['stacked'], props.single && s['single']]}
      data-testid="notif-card"
      data-id={String(id)}
      data-entering={entering() ? '' : undefined}
      data-leaving={props.entry.leaving ? '' : undefined}
      data-hidden={hidden() ? '' : undefined}
      style={{ '--i': String(depth()) }}
      onAnimationEnd={() => {
        if (props.entry.leaving) {
          removeToast(id);
        } else {
          setEntering(false);
        }
      }}
    >
      <div
        class={s['icon']}
        data-testid="notif-icon"
        data-tone={props.entry.tone}
        // eslint-disable-next-line solid/no-innerhtml -- trusted SVG from host code
        innerHTML={props.entry.icon}
      />
      <div class={s['text']} data-testid="notif-text">
        <span class={s['title']} data-testid="notif-title">
          {props.entry.label}
        </span>
        <Show
          when={props.entry.onActivate}
          fallback={
            <span class={s['body']} data-testid="notif-body">
              {props.entry.text}
            </span>
          }
        >
          {activate => (
            <button
              type="button"
              class={s['body']}
              data-testid="notif-body"
              onClick={event => {
                event.stopPropagation();
                activate()();
              }}
            >
              {props.entry.text}
            </button>
          )}
        </Show>
      </div>
      <Show when={props.entry.action}>
        {action => (
          <Button
            size="sm"
            class={s['action']}
            testId="notif-action"
            onClick={event => {
              event.stopPropagation();
              action().onClick();
            }}
          >
            {action().label}
          </Button>
        )}
      </Show>
      <IconButton
        size="sm"
        class={s['close']}
        testId="notif-card-close"
        aria-label="Dismiss"
        onClick={event => {
          event.stopPropagation();
          dismissToast(id);
        }}
      >
        <CloseIcon />
      </IconButton>
    </div>
  );
}
