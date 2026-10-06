// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Errored, Loading, onSettled } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { focusables, focusInto } from '../focus.js';
import { Spinner } from '../primitives/Spinner.js';
import { AnchoredContent } from './AnchoredContent.js';
import { Broken } from './broken.js';
import type { Placement } from './FloatingLayer.js';
import type { PopoverState } from './Popover.js';
import s from './Popover.module.css';

/**
 * Popover's lazy chunk: the content in its boundaries, a spinner while it
 * loads and Broken when it fails, with focus moving in as it renders.
 */
export function PopoverSurface(props: {
  state: PopoverState;
  class?: string | undefined;
  placement?: Placement | undefined;
  testId?: string | undefined;
  children: JSX.Element;
}): JSX.Element {
  const body = (root: () => HTMLElement | null | undefined): JSX.Element => (
    <Errored fallback={err => <Broken root={`popover:${props.state.id}`} error={err()} fail={props.state.close} />}>
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
    </Errored>
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

/** The first control Tab reaches in `root`, links skipped, as focusInto picks. */
function firstControl(root: HTMLElement): HTMLElement | undefined {
  return focusables(root).find(el => !(el instanceof HTMLAnchorElement));
}

/**
 * The popover opened before its content was in, so the surface itself took
 * focus (the anchored layer, or the sheet holding `root`): once the content
 * renders, focus moves into it.
 */
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
