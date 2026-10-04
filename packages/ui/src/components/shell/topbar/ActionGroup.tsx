// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, onCleanup, onSettled, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { TopbarContext, type TopbarBar, type TopbarEntry } from './context.js';
import { fitActions, layoutParent } from './fit.js';
import { OverflowMenu } from './OverflowMenu.js';
import s from './ActionGroup.module.css';

function sameNames(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every(name => b.has(name));
}

function inDocumentOrder(a: TopbarEntry, b: TopbarEntry): number {
  const ea = a.element();
  const eb = b.element();
  if (ea === undefined || eb === undefined) {
    return 0;
  }
  return ea.compareDocumentPosition(eb) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

/**
 * The topbar's action group (`#topbar-actions`): its children are the items
 * (each wrapping its button in a TopbarItem), in bar order, followed by the
 * More menu, then `end`, the item that ends the bar. Items sit in the bar
 * while they fit. The ones that do not move into the More menu, lowest
 * priority first (fitActions, TOPBAR_PRIORITY), and come back as room frees
 * up. The group fills its grid cell, so its width is the room there is. A
 * ResizeObserver on it, on every item and on the More button measures again
 * whenever one of them changes size (the window, an account badge, the chat
 * unread count), and an item showing or hiding does too. The More button
 * only shows while something is collapsed.
 *
 * `data-collapsible` marks the group once it is mounted and measuring. The
 * build-time render (the Astro page) goes without it, and until the group
 * hydrates, its items (TopbarItem) and the More button (OverflowMenu) read
 * its absence and lay themselves out for a narrow screen as the bar would
 * most likely fit them.
 */
export function ActionGroup(props: {
  /** The group's room, when its container knows better than its own width (a content-sized pill). */
  room?: ((group: HTMLElement) => number | undefined) | undefined;
  children: JSX.Element;
  /** The item that ends the bar after the More button (the account), one that never collapses. */
  end?: JSX.Element;
}): JSX.Element {
  let group: HTMLDivElement | undefined;
  let more: HTMLButtonElement | undefined;
  /** In registration order; sorted by document order where it matters. */
  const [entries, setEntries] = createSignal<readonly TopbarEntry[]>([], { ownedWrite: true });
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set(), {
    ownedWrite: true,
    equals: sameNames,
  });

  const [measuring, setMeasuring] = createSignal(false);
  onSettled(() => {
    setMeasuring(true);
  });

  const measure = (): void => {
    // Detached or not rendered (a hidden topbar), there is nothing to
    // measure against.
    if (group === undefined || !group.isConnected || group.clientWidth === 0) {
      return;
    }
    const present = untrack(entries)
      .filter(entry => entry.visible())
      .sort(inDocumentOrder);
    const flags = fitActions(
      present.map(entry => ({
        width: entry.element()?.getBoundingClientRect().width ?? 0,
        priority: entry.priority,
      })),
      props.room?.(group) ?? group.clientWidth,
      Number.parseFloat(getComputedStyle(group).columnGap) || 0,
      more?.getBoundingClientRect().width ?? 0,
    );
    setCollapsed(new Set(present.filter((_, i) => flags[i] === true).map(entry => entry.name)));
  };

  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
  onCleanup(() => observer?.disconnect());
  // In a content-sized pill the group's own size says nothing about its
  // room, so the row (the address changing) and the window are heard too.
  // Settled, so the build-time render, which has no window, skips it.
  onSettled(() => {
    const row = group === undefined ? null : layoutParent(group);
    if (row !== null) {
      observer?.observe(row);
    }
    const onResize = (): void => {
      measure();
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  });
  const observe = (el: HTMLElement): void => {
    observer?.observe(el);
  };

  const bar: TopbarBar = {
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

  // An item showing or hiding (the chat button, the network button) changes
  // what has to fit.
  createEffect(
    () => entries().map(entry => entry.visible()),
    () => {
      measure();
    },
  );

  /** The collapsed items that show, in bar order: the menu's rows. */
  const rows = createMemo(() =>
    entries()
      .filter(entry => entry.visible() && collapsed().has(entry.name))
      .sort(inDocumentOrder),
  );

  return (
    <TopbarContext value={bar}>
      <div
        ref={el => {
          group = el;
          observe(el);
        }}
        class={s['group']}
        id="topbar-actions"
        data-collapsible={measuring() ? '' : undefined}
      >
        {props.children}
        <OverflowMenu
          rows={rows()}
          buttonRef={el => {
            more = el;
            observe(el);
          }}
        />
        {props.end}
      </div>
    </TopbarContext>
  );
}
