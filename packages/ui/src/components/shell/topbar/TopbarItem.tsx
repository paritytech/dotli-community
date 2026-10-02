// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { useContext } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { TopbarContext } from './context.js';
import { PINNED } from './fit.js';
import s from './TopbarItem.module.css';

export interface TopbarItemProps {
  name: string;
  label: string;
  icon: () => JSX.Element;
  priority: number;
  /** Default true. A hidden item shows neither inline nor in the menu. */
  visible?: boolean;
  activate: (ev: MouseEvent) => void;
  /** The item's button. */
  children: JSX.Element;
}

/**
 * One item of the topbar's action group: wraps the item's button, and tells
 * the ActionGroup it sits in how to show it as a More menu row. While the
 * bar has collapsed it, the wrapper stays in place, out of flow and
 * invisible (`data-collapsed`), so it can still be measured and its button
 * still anchors its surface. Until the bar measures (its build-time render),
 * an item that may collapse is marked `data-unmeasured`, and a narrow
 * viewport hides it. Outside an ActionGroup (the landing page) it is always
 * inline.
 */
export function TopbarItem(props: TopbarItemProps): JSX.Element {
  const bar = useContext(TopbarContext);
  let element: HTMLSpanElement | undefined;
  const visible = (): boolean => props.visible !== false;
  const collapsed =
    bar?.register({
      get name() {
        return props.name;
      },
      get label() {
        return props.label;
      },
      icon: () => props.icon(),
      get priority() {
        return props.priority;
      },
      visible,
      activate: ev => {
        props.activate(ev);
      },
      element: () => element,
    }) ?? ((): boolean => false);

  return (
    <span
      ref={el => {
        element = el;
        bar?.observe(el);
      }}
      class={s['item']}
      data-testid="topbar-item"
      data-item={props.name}
      data-collapsed={collapsed() ? '' : undefined}
      data-unmeasured={bar !== null && !bar.measured() && props.priority !== PINNED ? '' : undefined}
      hidden={!visible()}
    >
      {props.children}
    </span>
  );
}
