// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, For, Show, untrack, type Component } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { dismissAllToasts, setToastsExpanded, toastsStore } from '@dotli/ui-core';
import { useStore } from '../use-store.js';
import { CloseIcon } from '../icons/CloseIcon.js';
import { ToastCard, type ToastCardProps } from './ToastCard.js';
import { pileDepths, scrollsToNewest, visibleToasts } from './toast-pile.js';
import s from './ToastStack.module.css';

export interface ToastStackProps {
  /** Draws each toast. Read once, and without one the stack's own card. */
  card?: Component<ToastCardProps>;
}

export function ToastStack(props: ToastStackProps): JSX.Element {
  const Card = untrack(() => props.card) ?? ToastCard;
  const items = useStore(toastsStore, state => state.items);
  const expanded = useStore(toastsStore, state => state.expanded);
  let root: HTMLDivElement | undefined;
  let cards: HTMLDivElement | undefined;

  // Worked out once per update, not once per card.
  const active = createMemo(() => items().filter(t => !t.leaving));
  const visible = createMemo(() => visibleToasts(active(), expanded()));
  const depths = createMemo(() => pileDepths(visible(), expanded()));
  const many = createMemo(() => active().length > 1);

  createEffect(
    () => items().length,
    (count, previous) => {
      if (cards !== undefined && scrollsToNewest(count, previous, untrack(expanded))) {
        cards.scrollTop = cards.scrollHeight;
      }
    },
  );

  createEffect(expanded, isExpanded => {
    if (!isExpanded) {
      return;
    }
    if (cards !== undefined) {
      cards.scrollTop = cards.scrollHeight;
    }
    const onOutsideClick = (event: MouseEvent): void => {
      if (root !== undefined && !root.contains(event.target as Node)) {
        setToastsExpanded(false);
      }
    };
    const onBlur = (): void => {
      setToastsExpanded(false);
    };
    document.addEventListener('click', onOutsideClick, true);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('click', onOutsideClick, true);
      window.removeEventListener('blur', onBlur);
    };
  });

  const onStackClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement;
    if (!expanded() && many() && cards !== undefined && cards.contains(target) && target.closest('a') === null) {
      setToastsExpanded(true);
    }
  };

  return (
    <Show when={items().length > 0}>
      <div
        ref={el => {
          root = el;
        }}
        class={s['stack']}
        data-chrome=""
        data-testid="notif-stack"
        data-expanded={expanded() ? '' : undefined}
        onClick={onStackClick}
      >
        <div
          ref={el => {
            cards = el;
          }}
          class={s['cards']}
          data-testid="notif-cards"
          role="status"
          aria-live="polite"
          style={{
            cursor: !expanded() && many() ? 'pointer' : '',
          }}
        >
          <For each={items()} keyed={t => t.id}>
            {entry => (
              <Card
                entry={entry()}
                hidden={!depths().has(entry().id)}
                depth={depths().get(entry().id) ?? (expanded() ? 0 : visible().length)}
                expanded={expanded()}
                single={!many()}
              />
            )}
          </For>
        </div>
        <button
          type="button"
          class={s['closeAll']}
          data-testid="notif-close-all"
          aria-label="Dismiss all"
          style={{ display: many() ? '' : 'none' }}
          onClick={event => {
            event.stopPropagation();
            dismissAllToasts();
            setToastsExpanded(false);
          }}
        >
          <CloseIcon />
        </button>
      </div>
    </Show>
  );
}
