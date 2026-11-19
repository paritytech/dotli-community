// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createUniqueId, Show, type Component } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { CheckIcon } from '../icons/CheckIcon.js';
import { CloseIcon } from '../icons/CloseIcon.js';
import { DrawIcon } from '../icons/DrawIcon.js';
import type { IconProps } from '../icons/iconProps.js';
import { createOverflow } from '../createOverflow.js';
import { anchorName } from '../floating/anchorName.js';
import { FloatingLayer } from '../floating/FloatingLayer.js';
import { SectionLabel } from './SectionLabel.js';
import { Spinner } from './Spinner.js';
import s from './Listbox.module.css';

export const Listbox = Object.assign(ListboxRoot, { Group, Option });

/**
 * A list of options in a floating layer placed below `anchor`, at least as wide as it, which never takes focus, so the
 * control that opened it keeps its keys. It names the anchor for the placement itself while it holds one. A press
 * outside the list, Escape and focus leaving the anchor and the list close it through `onClose`, and its caller sets
 * `open` from that. While `loading` is set, a status row with that text follows the options.
 */
function ListboxRoot(props: {
  id: string;
  label: string;
  /** The control the list drops below, undefined while there is none. */
  anchor: HTMLElement | undefined;
  open: boolean;
  onClose: () => void;
  align?: 'start' | 'end' | undefined;
  loading?: string | undefined;
  testId?: string | undefined;
  children: JSX.Element;
}): JSX.Element {
  const layerId = (): string => `${props.id}-layer`;
  // From the first opening on, so a list that never opens adds nothing to the page.
  const mounted = createMemo<boolean>(wasMounted => wasMounted === true || props.open);
  createEffect(
    () => ({ anchor: props.anchor, name: anchorName(layerId()) }),
    ({ anchor, name }) => {
      if (anchor === undefined) {
        return;
      }
      anchor.style.setProperty('anchor-name', name);
      return () => {
        anchor.style.removeProperty('anchor-name');
      };
    },
  );
  return (
    <Show when={mounted()}>
      <FloatingLayer
        id={layerId()}
        kind="auto"
        open={props.open}
        onClose={() => {
          props.onClose();
        }}
        trigger={() => props.anchor}
        placement={props.align === 'end' ? 'trigger-end' : 'trigger-start'}
        class={s['layer']}
      >
        <OptionList id={props.id} label={props.label} busy={props.loading !== undefined} testId={props.testId}>
          {props.children}
        </OptionList>
        {/* Outside the list, since a listbox may own only options. */}
        <Show when={props.loading}>
          {text => (
            <div class={s['status']} role="status">
              <Spinner class={s['spinner']} />
              {text()}
            </div>
          )}
        </Show>
      </FloatingLayer>
    </Show>
  );
}

/** The listbox itself, inside the layer, so each opening measures its own overflow. */
function OptionList(props: {
  id: string;
  label: string;
  busy: boolean;
  testId: string | undefined;
  children: JSX.Element;
}): JSX.Element {
  const overflow = createOverflow();
  return (
    <ul
      ref={overflow.ref}
      id={props.id}
      class={s['list']}
      data-overflows={overflow.overflows() ? '' : undefined}
      role="listbox"
      aria-label={props.label}
      aria-busy={props.busy ? 'true' : undefined}
      data-testid={props.testId}
    >
      {props.children}
    </ul>
  );
}

/** A section of options under a visible heading that names it. The caller leaves out a section with no options. */
function Group(props: { label: string; children: JSX.Element }): JSX.Element {
  const headingId = createUniqueId();
  return (
    // A listbox may own only options and groups, and an item may not be a group, so the items around them are none.
    <li role="none">
      <ul class={s['group']} role="group" aria-labelledby={headingId}>
        <li role="none">
          <SectionLabel text={props.label} id={headingId} class={s['heading']} />
        </li>
        {props.children}
      </ul>
    </li>
  );
}

/**
 * One option. `active` is the option the arrow keys point at, and `chosen` is the control's current value. With
 * `remove`, the row ends in a cross for mouse and touch that calls `onRemove` and never picks the option. Keyboard and
 * screen reader users remove with Shift+Delete, which the option announces and the control's key handling runs.
 */
function Option(props: {
  id: string;
  active?: boolean | undefined;
  chosen?: boolean | undefined;
  icon?: Component<IconProps> | undefined;
  detail?: string | undefined;
  remove?: { label: string; onRemove: () => void } | undefined;
  onPick: () => void;
  testId?: string | undefined;
  children: JSX.Element;
}): JSX.Element {
  let element: HTMLLIElement | undefined;
  createEffect(
    () => props.active === true,
    active => {
      if (active) {
        element?.scrollIntoView({ block: 'nearest' });
      }
    },
  );
  return (
    <li
      ref={el => {
        element = el;
      }}
      id={props.id}
      class={s['option']}
      role="option"
      aria-selected={props.active === true ? 'true' : 'false'}
      aria-checked={props.chosen === true ? 'true' : undefined}
      aria-keyshortcuts={props.remove === undefined ? undefined : 'Shift+Delete'}
      data-testid={props.testId}
      onMouseDown={event => {
        // The control that opened the list keeps focus, so its keys still drive the list. A touch tap fires this too.
        event.preventDefault();
      }}
      onClick={() => {
        props.onPick();
      }}
    >
      <Show when={props.icon}>{icon => <DrawIcon icon={icon()} class={s['icon']} />}</Show>
      <span class={s['text']}>
        {props.children}
        <Show when={props.detail}>{detail => <span class={s['detail']}>{detail()}</span>}</Show>
      </span>
      <Show when={props.chosen === true}>
        <CheckIcon class={s['check']} />
      </Show>
      {/* An option may hold no interactive control, and a button with a negative tabindex is still one, so the
          pointer's control is a plain element. */}
      <Show when={props.remove}>
        {remove => (
          <span
            class={s['remove']}
            aria-hidden="true"
            title={remove().label}
            data-testid="listbox-remove"
            onClick={event => {
              // The row's own click would pick the option.
              event.stopPropagation();
              remove().onRemove();
            }}
          >
            <CloseIcon class={s['removeIcon']} />
          </span>
        )}
      </Show>
    </li>
  );
}
