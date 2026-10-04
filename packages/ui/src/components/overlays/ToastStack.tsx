// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, For, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { dismissAllToasts, setToastsExpanded, toastsStore } from '../../state/toasts.js';
import { useStore } from '../use-store.js';
import { CloseIcon } from '../primitives/IconButton.js';
import { ToastCard } from './ToastCard.js';
import s from './ToastStack.module.css';

const MAX_STACK = 3;

export function ToastStack(): JSX.Element {
  const items = useStore(toastsStore, state => state.items);
  const expanded = useStore(toastsStore, state => state.expanded);
  let root: HTMLDivElement | undefined;
  let cards: HTMLDivElement | undefined;

  // Worked out once per update, not once per card.
  const active = createMemo(() => items().filter(t => !t.leaving));
  const visible = createMemo(() => (expanded() ? active() : active().slice(-MAX_STACK)));
  // Each visible card's depth in the collapsed pile (0 = newest). A card
  // missing from the map is hidden, and sits just behind the pile.
  const depths = createMemo(() => {
    const shown = visible();
    const collapsed = !expanded();
    const map = new Map<number, number>();
    shown.forEach((t, i) => {
      map.set(t.id, collapsed ? shown.length - 1 - i : 0);
    });
    return map;
  });
  const many = createMemo(() => active().length > 1);

  // While expanded, a new toast (the list grew) scrolls the newest card into
  // view. Dismissing one, or an unrelated write, leaves the scroll alone.
  createEffect(
    () => items().length,
    (count, previous) => {
      if (previous !== undefined && count > previous && cards !== undefined && untrack(expanded)) {
        cards.scrollTop = cards.scrollHeight;
      }
    },
  );

  // While expanded: scroll to the newest card, and collapse on an outside
  // click (capture phase) or when the window loses focus.
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
