// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { SheetHead } from '../sheet/SheetHead.js';
import frame from '../sheet/Sheet.module.css';
import type { Popover } from '../shell/create-popover.js';
import s from './Menu.module.css';

export interface MenuProps {
  id: string;
  /**
   * The menu's createPopover (`menu` mode, `sheet: true`), wired to the
   * surface it receives through `ref`. Menu shows its open state, its sheet
   * form (over a scrim, led by a head) and its hand-off (it and its scrim
   * appear or go at once), and a swipe down on the sheet's head, or its
   * close button, closes it.
   */
  popover: Pick<Popover, 'open' | 'sheet' | 'handedOff' | 'setOpen'>;
  /** Receives the surface, for createPopover's `menu` mode. */
  ref: (el: HTMLDivElement) => void;
  /** The menu's accessible name, and its sheet's title. */
  label: string;
  /** `horizontal` for a row of items (the Appearance tiles): Left and Right move between them too. */
  orientation?: 'horizontal' | undefined;
  onClick?: (ev: MouseEvent) => void;
  class?: string | undefined;
  children: JSX.Element;
}

/**
 * Keys, focus and dismissal are createPopover's `menu` mode, which the
 * consumer wires to the surface it receives through `ref`.
 *
 * As a sheet (components/sheet) the scrim comes first, outside the surface,
 * so a press on it is a press outside the menu, which closes it. The surface
 * is then the frame: the head, with its close button, and under it the body
 * that scrolls, which is the `role="menu"` element, since a menu holds only
 * its items. The surface keeps the id and the state attributes in both
 * forms.
 */
export function Menu(props: MenuProps): JSX.Element {
  let surface: HTMLDivElement | undefined;
  const sheet = (): boolean => props.popover.sheet();
  const open = (): string | undefined => (props.popover.open() ? '' : undefined);
  const handoff = (): string | undefined => (props.popover.handedOff() ? '' : undefined);
  return (
    <>
      <Show when={sheet()}>
        <div
          class={frame['scrim']}
          data-testid="menu-scrim"
          data-open={open()}
          data-handoff={handoff()}
          aria-hidden="true"
        />
      </Show>
      <div
        ref={el => {
          surface = el;
          props.ref(el);
        }}
        onClick={ev => props.onClick?.(ev)}
        class={[frame['anchored'], s['menu'], frame['sheet'], props.class]}
        id={props.id}
        role={sheet() ? undefined : 'menu'}
        aria-label={sheet() ? undefined : props.label}
        aria-orientation={sheet() ? undefined : props.orientation}
        data-chrome=""
        tabindex="-1"
        data-open={open()}
        data-sheet={sheet() ? '' : undefined}
        data-handoff={handoff()}
      >
        {/* Each form renders the items afresh: the form changes only as an
            opening starts. */}
        <Show when={sheet()} fallback={props.children}>
          <SheetHead
            title={props.label}
            surface={() => surface}
            onDismiss={() => {
              props.popover.setOpen(false);
            }}
            closeLabel="Close"
            testId="menu-sheet-head"
            titleTestId="menu-sheet-title"
            closeTestId="menu-sheet-close"
          />
          <div
            class={frame['body']}
            role="menu"
            aria-label={props.label}
            aria-orientation={props.orientation}
            tabindex="-1"
            data-testid="menu-sheet-body"
          >
            {props.children}
          </div>
        </Show>
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
