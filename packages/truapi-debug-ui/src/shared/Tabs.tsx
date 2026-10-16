// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, For } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { rovingTarget } from './roving.js';
import s from './Tabs.module.css';

export interface TabOption<T extends string> {
  value: T;
  label: string;
}

/** The id of the tab for `value` in the strip whose ids start with `idPrefix`, which its panel names as its label. */
export function tabId(idPrefix: string, value: string): string {
  return `${idPrefix}-${value}`;
}

/**
 * A tab strip. Each tab carries its value as `data-value`. The strip is one Tab stop, and the arrow keys, Home and End
 * move the focus without picking, so a keyboard user can look along it before opening a tab.
 */
export function Tabs<T extends string>(props: {
  tabs: readonly TabOption<T>[];
  /** None while the strip's panel is folded away, so no tab claims to show it. */
  selected: T | null;
  onSelect: (value: T) => void;
  /** `primary` for the panel's top-level tabs, `secondary` for tabs inside one. */
  variant: 'primary' | 'secondary';
  /** The strip's name. */
  label: string;
  /** Starts each tab's id. */
  idPrefix: string;
  /** The one panel that shows the selected tab's content. */
  panelId: string;
  testId: string;
  tabTestId: string;
  hidden?: boolean;
  class?: string | undefined;
}): JSX.Element {
  // Without it, Tab from an arrow-focused tab stops on the selected one before leaving.
  const [focused, setFocused] = createSignal<number | null>(null);
  const tabStop = (): number =>
    focused() ??
    Math.max(
      props.tabs.findIndex(tab => tab.value === props.selected),
      0,
    );

  const tabsOf = (strip: HTMLElement): HTMLButtonElement[] =>
    Array.from(strip.querySelectorAll<HTMLButtonElement>(':scope > [role="tab"]'));

  const onFocusIn = (e: FocusEvent): void => {
    const { currentTarget, target } = e;
    if (!(currentTarget instanceof HTMLElement) || !(target instanceof HTMLButtonElement)) {
      return;
    }
    const index = tabsOf(currentTarget).indexOf(target);
    setFocused(index < 0 ? null : index);
  };

  const onFocusOut = (e: FocusEvent): void => {
    const { currentTarget, relatedTarget } = e;
    if (
      currentTarget instanceof HTMLElement &&
      !(relatedTarget instanceof Node && currentTarget.contains(relatedTarget))
    ) {
      setFocused(null);
    }
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    const { currentTarget, target } = e;
    if (!(currentTarget instanceof HTMLElement) || !(target instanceof HTMLButtonElement)) {
      return;
    }
    const tabs = tabsOf(currentTarget);
    const index = tabs.indexOf(target);
    const next = index < 0 ? null : rovingTarget(e.key, index, tabs.length, e.altKey || e.ctrlKey || e.metaKey);
    if (next === null) {
      return;
    }
    e.preventDefault();
    tabs[next]?.focus();
  };

  return (
    <div
      class={[s['tabs'], props.class]}
      data-testid={props.testId}
      role="tablist"
      aria-label={props.label}
      hidden={props.hidden}
      onKeyDown={onKeyDown}
      onFocusIn={onFocusIn}
      onFocusOut={onFocusOut}
    >
      <For each={props.tabs}>
        {(tab, index) => (
          <button
            id={tabId(props.idPrefix, tab.value)}
            class={[s['tab'], s[props.variant]]}
            data-testid={props.tabTestId}
            data-value={tab.value}
            role="tab"
            aria-selected={props.selected === tab.value ? 'true' : 'false'}
            aria-controls={props.panelId}
            tabindex={index() === tabStop() ? 0 : -1}
            type="button"
            onClick={() => {
              props.onSelect(tab.value);
            }}
          >
            {tab.label}
          </button>
        )}
      </For>
    </div>
  );
}
