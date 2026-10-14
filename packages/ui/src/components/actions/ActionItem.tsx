// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { useContext, type Component } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { IconProps } from '../icons/icon-props.js';
import { ActionsContext, type ActionAlert } from './actions-context.js';
import s from './ActionItem.module.css';

export interface ActionItemProps {
  name: string;
  label: string;
  icon: Component<IconProps>;
  /** A status the More button raises while the item is in the menu. */
  alert?: ActionAlert | undefined;
  /** Shown in the item's More row after its label. */
  aside?: (() => JSX.Element) | undefined;
  /** The lowest moves into More first. `PINNED` never does. */
  priority: number;
  /** A hidden item shows neither inline nor in the menu. */
  visible?: boolean;
  activate: (ev: MouseEvent) => void;
  /** Set apart from the items before it by a hairline, in a group. */
  separated?: boolean;
  /** The view the item shows, its button first. */
  children: JSX.Element;
}

/** Wraps an item's button and tells its group how to show it as a More row. Outside a group it is always inline. */
export function ActionItem(props: ActionItemProps): JSX.Element {
  const bar = useContext(ActionsContext);
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
      get icon() {
        return props.icon;
      },
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
      data-testid="action-item"
      data-item={props.name}
      data-parked={collapsed() ? '' : undefined}
      data-separated={bar !== null && props.separated === true ? '' : undefined}
      hidden={!visible()}
    >
      {props.children}
    </span>
  );
}
