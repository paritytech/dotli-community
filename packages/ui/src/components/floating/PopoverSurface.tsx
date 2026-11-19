// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Loading, onSettled, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { focusables } from '../../page/focusables.js';
import { focusInto } from '../focus.js';
import { Spinner } from '../primitives/Spinner.js';
import { RootBoundary } from '../../mount/rootBoundary.js';
import { FloatingLayer, type Placement } from './FloatingLayer.js';
import type { PopoverState } from './Popover.js';
import { SheetContent } from './SheetContent.js';
import s from './Popover.module.css';

/** Popover's surface: an anchored layer or a sheet, with the content's own loading and failure. */
export function PopoverSurface(props: {
  state: PopoverState;
  class?: string | undefined;
  placement?: Placement | undefined;
  testId?: string | undefined;
  initialFocus?: ((root: HTMLElement) => HTMLElement | undefined) | undefined;
  children: JSX.Element;
}): JSX.Element {
  const placeFocus = (root: HTMLElement): void => {
    const pick = props.initialFocus;
    if (pick === undefined) {
      focusInto(root);
      return;
    }
    const target = pick(root);
    focusInto(root, target === undefined ? [] : [target]);
  };
  const body = (root: () => HTMLElement | null | undefined): JSX.Element => (
    <RootBoundary root={`popover:${props.state.id}`} onBroken={props.state.close}>
      <Loading
        fallback={
          <div class={s['loading']} data-testid="popover-loading" aria-hidden="true">
            <Spinner class={s['spinner']} />
          </div>
        }
      >
        {props.children}
        <FocusWhenLoaded root={root} focus={placeFocus} />
      </Loading>
    </RootBoundary>
  );
  return (
    <Show
      when={props.state.sheet()}
      fallback={
        <FloatingLayer
          id={props.state.id}
          kind="auto"
          open={props.state.open()}
          onClose={reason => {
            props.state.setOpen(false, reason);
          }}
          trigger={props.state.trigger}
          placement={props.placement ?? 'topbar-end'}
          role="dialog"
          label={props.state.title}
          class={[s['surface'], props.class]}
          testId={props.testId}
          trapFocus
          onOpened={surface => {
            placeFocus(surface);
          }}
        >
          {body(() => document.getElementById(props.state.id))}
        </FloatingLayer>
      }
    >
      <SheetContent
        state={props.state}
        testId="popover"
        focus={wrapper => (props.initialFocus === undefined ? firstControl(wrapper) : props.initialFocus(wrapper))}
        content={wrapper => body(wrapper)}
      />
    </Show>
  );
}

/** Skips links, matching what focusInto picks. */
function firstControl(root: HTMLElement): HTMLElement | undefined {
  return focusables(root).find(el => !(el instanceof HTMLAnchorElement));
}

/** A popover that opened before its content loaded focused the surface itself, so focus moves in once it renders. */
function FocusWhenLoaded(props: {
  root: () => HTMLElement | null | undefined;
  focus: (root: HTMLElement) => void;
}): JSX.Element {
  onSettled(() => {
    const root = props.root();
    if (root === null || root === undefined) {
      return;
    }
    const holder = root.closest('[data-modal-surface]') ?? root;
    if (document.activeElement === holder) {
      props.focus(root);
    }
  });
  return null;
}
