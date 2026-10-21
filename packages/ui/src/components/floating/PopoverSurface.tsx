// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Loading, onSettled } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { focusables } from '../../page/focusables.js';
import { focusInto } from '../focus.js';
import { Spinner } from '../primitives/Spinner.js';
import { AnchoredContent } from './AnchoredContent.js';
import { RootBoundary } from '../../mount/root-boundary.js';
import type { Placement } from './FloatingLayer.js';
import type { PopoverState } from './Popover.js';
import s from './Popover.module.css';

/** Popover's surface: an anchored layer or a sheet, with the content's own loading and failure. */
export function PopoverSurface(props: {
  state: PopoverState;
  class?: string | undefined;
  placement?: Placement | undefined;
  testId?: string | undefined;
  children: JSX.Element;
}): JSX.Element {
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
        <FocusWhenLoaded root={root} />
      </Loading>
    </RootBoundary>
  );
  return (
    <AnchoredContent
      state={props.state}
      role="dialog"
      placement={props.placement}
      class={[s['surface'], props.class].filter(Boolean).join(' ')}
      testId={props.testId}
      trapFocus
      onOpened={surface => {
        focusInto(surface);
      }}
      sheetTestId="popover"
      sheetFocus={firstControl}
      sheetChildren={wrapper => body(wrapper)}
    >
      {body(() => document.getElementById(props.state.id))}
    </AnchoredContent>
  );
}

/** Skips links, matching what focusInto picks. */
function firstControl(root: HTMLElement): HTMLElement | undefined {
  return focusables(root).find(el => !(el instanceof HTMLAnchorElement));
}

/** A popover that opened before its content loaded focused the surface itself, so focus moves in once it renders. */
function FocusWhenLoaded(props: { root: () => HTMLElement | null | undefined }): JSX.Element {
  onSettled(() => {
    const root = props.root();
    if (root === null || root === undefined) {
      return;
    }
    const holder = root.closest('[data-modal-surface]') ?? root;
    if (document.activeElement === holder) {
      focusInto(root);
    }
  });
  return null;
}
