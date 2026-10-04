// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { SheetHead } from '../sheet/SheetHead.js';
import frame from '../sheet/Sheet.module.css';
import s from './Menu.module.css';

export interface MenuProps {
  id: string;
  open: boolean;
  /** Receives the surface, for createPopover's `menu` mode. */
  ref: (el: HTMLDivElement) => void;
  label?: string;
  labelledBy?: string;
  /** `horizontal` for a row of items (the Appearance tiles): Left and Right move between them too. */
  orientation?: 'horizontal' | undefined;
  onClick?: (ev: MouseEvent) => void;
  class?: string | undefined;
  testId?: string;
  /**
   * Show as a bottom sheet (createPopover's `sheet()`): over a scrim, led by
   * a head with the grabber and `sheetTitle`.
   */
  sheet?: boolean | undefined;
  /** The sheet head's title. Assistive technology reads the menu's own name instead. */
  sheetTitle?: string | undefined;
  /** A swipe down on the sheet's head asks to close it. */
  onDismiss?: (() => void) | undefined;
  children: JSX.Element;
}

/**
 * Keys, focus and dismissal are createPopover's `menu` mode, which the
 * consumer wires to the surface it receives through `ref`.
 *
 * As a sheet (components/sheet) the scrim comes first, outside the surface,
 * so a press on it is a press outside the menu, which closes it. The head is
 * hidden from assistive technology and takes no focus, so the menu keeps only
 * its items, and it has no close button, which `role="menu"` cannot hold.
 */
export function Menu(props: MenuProps): JSX.Element {
  let surface: HTMLDivElement | undefined;
  const sheet = (): boolean => props.sheet === true;

  return (
    <>
      <Show when={sheet()}>
        <div
          class={frame['scrim']}
          data-testid="menu-scrim"
          data-open={props.open ? '' : undefined}
          aria-hidden="true"
        />
      </Show>
      <div
        ref={el => {
          surface = el;
          props.ref(el);
        }}
        onClick={ev => props.onClick?.(ev)}
        class={[s['menu'], frame['sheet'], props.class]}
        id={props.id}
        role="menu"
        data-chrome=""
        aria-label={props.label}
        aria-labelledby={props.labelledBy}
        aria-orientation={props.orientation}
        tabindex="-1"
        data-open={props.open ? '' : undefined}
        data-sheet={sheet() ? '' : undefined}
        data-testid={props.testId}
      >
        <Show when={sheet()}>
          <SheetHead
            title={props.sheetTitle ?? ''}
            surface={() => surface}
            onDismiss={() => props.onDismiss?.()}
            hidden
            testId="menu-sheet-head"
            titleTestId="menu-sheet-title"
          />
        </Show>
        {props.children}
      </div>
    </>
  );
}

// Explicit props, not a rest spread of button attributes: splitting the rest
// off pulls Solid's `omit` into the boot bundle.
export interface MenuRowProps {
  onClick?: (ev: MouseEvent) => void;
  'data-item'?: string;
  'data-theme-option'?: string;
  children?: JSX.Element;
  /** `menuitemradio` for one of a set of choices, with `checked`. */
  role?: 'menuitem' | 'menuitemradio';
  checked?: boolean;
  class?: string | undefined;
  testId?: string;
}

export function MenuRow(props: MenuRowProps): JSX.Element {
  return (
    <button
      onClick={ev => {
        props.onClick?.(ev);
      }}
      data-item={props['data-item']}
      data-theme-option={props['data-theme-option']}
      class={[s['row'], props.class]}
      role={props.role ?? 'menuitem'}
      aria-checked={props.role === 'menuitemradio' ? (props.checked === true ? 'true' : 'false') : undefined}
      tabindex="-1"
      data-testid={props.testId}
    >
      {props.children}
    </button>
  );
}
