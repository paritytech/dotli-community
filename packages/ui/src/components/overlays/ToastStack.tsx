// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, For, onSettled, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { toasts } from '../../page/state/createToasts.js';
import { useStore } from '../useStore.js';
import { CloseIcon } from '../icons/CloseIcon.js';
import { ToastCard } from './ToastCard.js';
import { getPileDepths, isScrollingToNewest, getVisibleToasts } from './toastPile.js';
import s from './ToastStack.module.css';

/**
 * The page's toasts as a stack that a click expands and an outside click or the window's blur collapses. Showing it
 * starts the countdowns.
 */
export function ToastStack(): JSX.Element {
  const items = useStore(toasts.store, state => state.items);
  const expanded = useStore(toasts.store, state => state.expanded);
  let root: HTMLDivElement | undefined;
  let cards: HTMLDivElement | undefined;

  // Countdowns start only once a view shows the toasts.
  onSettled(toasts.show);

  // Worked out once per update, not once per card.
  const active = createMemo(() => items().filter(toast => !toast.leaving));
  const visible = createMemo(() => getVisibleToasts(active(), expanded()));
  const depths = createMemo(() => getPileDepths(visible(), expanded()));
  const many = createMemo(() => active().length > 1);

  createEffect(
    () => items().length,
    (count, previous) => {
      if (cards !== undefined && isScrollingToNewest({ count, previous, expanded: untrack(expanded) })) {
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
    function collapseOnOutsideClick(event: MouseEvent): void {
      const target = event.target;
      if (root !== undefined && !(target instanceof Node && root.contains(target))) {
        toasts.setExpanded(false);
      }
    }
    function collapseOnBlur(): void {
      toasts.setExpanded(false);
    }
    document.addEventListener('click', collapseOnOutsideClick, true);
    window.addEventListener('blur', collapseOnBlur);
    return stopCollapsing;

    function stopCollapsing(): void {
      document.removeEventListener('click', collapseOnOutsideClick, true);
      window.removeEventListener('blur', collapseOnBlur);
    }
  });

  function expandOnStackClick(event: MouseEvent): void {
    const target = event.target;
    if (
      !expanded() &&
      many() &&
      cards !== undefined &&
      target instanceof Element &&
      cards.contains(target) &&
      target.closest('a') === null
    ) {
      toasts.setExpanded(true);
    }
  }

  return (
    <Show when={items().length > 0}>
      <div
        ref={element => {
          root = element;
        }}
        class={s['stack']}
        data-chrome=""
        data-testid="notif-stack"
        data-expanded={expanded() ? '' : undefined}
        onClick={expandOnStackClick}
      >
        <div
          ref={element => {
            cards = element;
          }}
          class={s['cards']}
          data-testid="notif-cards"
          role="status"
          aria-live="polite"
          data-expandable={!expanded() && many() ? '' : undefined}
        >
          <For each={items()} keyed={toast => toast.id}>
            {entry => (
              <ToastCard
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
          hidden={!many()}
          onClick={event => {
            event.stopPropagation();
            toasts.dismissAll();
            toasts.setExpanded(false);
          }}
        >
          <CloseIcon class={s['closeAllIcon']} />
        </button>
      </div>
    </Show>
  );
}
