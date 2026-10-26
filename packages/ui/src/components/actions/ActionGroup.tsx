// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, createUniqueId, onCleanup, onSettled, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { AnchorBoundary } from '../floating/layer-context.js';
import { ActionsContext, type ActionBar, type ActionEntry } from './actions-context.js';
import { fitActions, layoutParent } from './fit.js';
import { OverflowMenu } from './OverflowMenu.js';
import s from './ActionGroup.module.css';

function sameNames(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every(name => b.has(name));
}

function inDocumentOrder(a: ActionEntry, b: ActionEntry): number {
  const ea = a.element();
  const eb = b.element();
  if (ea === undefined || eb === undefined) {
    return 0;
  }
  return ea.compareDocumentPosition(eb) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

/** A container animation that resizes the group's row every frame until it ends. */
export type ActionGroupMorph = {
  running: () => boolean;
  onEnd: (listener: () => void) => () => void;
};

/** The ids of the More button and its menu, for a page that addresses them. */
export type MoreIds = {
  buttonId: string;
  menuId: string;
};

/**
 * A row of actions. Items that do not fit move into More, lowest priority first, and come back as room frees up.
 * `data-collapsible` waits for hydration, so a build-time render shows every item and no More.
 */
export function ActionGroup(props: {
  id?: string | undefined;
  more?: MoreIds | undefined;
  /** The group's room, when its container knows better than its own width (a content-sized pill). */
  room?: ((group: HTMLElement, row: HTMLElement | null) => number | undefined) | undefined;
  /** The container's own morph, during which the group waits and measures once it ends. */
  morph?: ActionGroupMorph | undefined;
  children: JSX.Element;
  /** Ends the group after More, and never collapses. */
  end?: JSX.Element;
}): JSX.Element {
  const moreId = createUniqueId();
  let group: HTMLDivElement | undefined;
  let more: HTMLButtonElement | undefined;
  /** Past the island's wrapper. Fixed once mounted. */
  let row: HTMLElement | null = null;
  /** In registration order, sorted by document order where it matters. */
  const [entries, setEntries] = createSignal<readonly ActionEntry[]>([], { ownedWrite: true });
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set(), {
    ownedWrite: true,
    equals: sameNames,
  });

  const [measuring, setMeasuring] = createSignal(false);
  onSettled(() => {
    setMeasuring(true);
  });
  // Until the first measure, an item may still move into More, so `data-measured` tells when the row has settled.
  const [measured, setMeasured] = createSignal(false, { ownedWrite: true });

  const measure = (): void => {
    // Detached or not rendered (a hidden container), there is nothing to measure against.
    if (group === undefined || !group.isConnected || group.clientWidth === 0) {
      return;
    }
    // Mid-morph the row stretches every frame while the room stays the same.
    if (props.morph?.running() === true) {
      return;
    }
    row ??= layoutParent(group);
    const present = untrack(entries)
      .filter(entry => entry.visible())
      .sort(inDocumentOrder);
    const flags = fitActions(
      present.map(entry => ({
        width: entry.element()?.getBoundingClientRect().width ?? 0,
        priority: entry.priority,
      })),
      props.room?.(group, row) ?? group.clientWidth,
      Number.parseFloat(getComputedStyle(group).columnGap) || 0,
      more?.getBoundingClientRect().width ?? 0,
    );
    setCollapsed(new Set(present.filter((_, i) => flags[i] === true).map(entry => entry.name)));
    setMeasured(true);
  };

  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
  onCleanup(() => observer?.disconnect());
  // In a content-sized pill the group's own size says nothing about its room, so the row and the window are
  // heard too. The row alone misses a widening window, as a pill under its max width keeps its size.
  onSettled(() => {
    row ??= group === undefined ? null : layoutParent(group);
    if (row !== null) {
      observer?.observe(row);
    }
    const onResize = (): void => {
      measure();
    };
    window.addEventListener('resize', onResize);
    const offMorph = props.morph?.onEnd(measure);
    return () => {
      window.removeEventListener('resize', onResize);
      offMorph?.();
    };
  });
  const observe = (el: HTMLElement): void => {
    observer?.observe(el);
  };

  const bar: ActionBar = {
    register: entry => {
      setEntries(list => [...list, entry]);
      onCleanup(() => {
        setEntries(list => list.filter(other => other !== entry));
      });
      return () => collapsed().has(entry.name);
    },
    observe,
    moreButton: () => more,
  };
  // A popover or menu whose trigger the bar collapsed hands focus back to More.
  const boundary: AnchorBoundary = { fallbackFocus: bar.moreButton };

  // An item showing or hiding changes what has to fit.
  createEffect(
    () => entries().map(entry => entry.visible()),
    () => {
      // The measure's reads are deliberately untracked, which also keeps the strict-read check quiet.
      untrack(measure);
    },
  );

  const rows = createMemo(() =>
    entries()
      .filter(entry => entry.visible() && collapsed().has(entry.name))
      .sort(inDocumentOrder),
  );

  return (
    <ActionsContext value={bar}>
      <AnchorBoundary value={boundary}>
        <div
          ref={el => {
            group = el;
            observe(el);
          }}
          class={s['group']}
          id={props.id}
          data-collapsible={measuring() ? '' : undefined}
          data-measured={measured() ? '' : undefined}
        >
          {props.children}
          <OverflowMenu
            class={s['more']}
            rows={rows()}
            buttonId={props.more?.buttonId ?? `${moreId}-button`}
            menuId={props.more?.menuId ?? `${moreId}-menu`}
            buttonRef={el => {
              more = el;
              observe(el);
            }}
          />
          {props.end}
        </div>
      </AnchorBoundary>
    </ActionsContext>
  );
}
