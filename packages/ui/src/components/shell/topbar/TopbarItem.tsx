// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { useContext } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { TopbarContext, type TopbarAlert } from './context.js';
import s from './TopbarItem.module.css';

export interface TopbarItemProps {
  name: string;
  label: string;
  icon: () => JSX.Element;
  /** A status the More button raises while the item is in the menu. */
  alert?: TopbarAlert | undefined;
  /** Shown in the item's More row after its label. */
  aside?: (() => JSX.Element) | undefined;
  priority: number;
  /** A hidden item shows neither inline nor in the menu. */
  visible?: boolean;
  activate: (ev: MouseEvent) => void;
  /** Set apart from the items before it by a hairline, in a bar (the account). */
  separated?: boolean;
  /** The item's button. */
  children: JSX.Element;
}

/** Wraps an item's button and tells the ActionGroup how to show it as a More row. Outside one it is always inline. */
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
      alert: () => props.alert,
      aside: () => props.aside,
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
      data-parked={collapsed() ? '' : undefined}
      data-separated={bar !== null && props.separated === true ? '' : undefined}
      hidden={!visible()}
    >
      {props.children}
    </span>
  );
}
