// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Shared dialog shell: the scrim and the glass card (a bottom sheet at 560 px
// and below), dialog semantics, initial focus, a Tab trap, Escape, and focus
// restored on close.

import { onCleanup, onSettled } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { currentProductFrame } from '../../product-frame-layout.js';
import { containTab } from '../focus.js';
import s from './Dialog.module.css';

export interface DialogProps {
  titleId: string;
  /** Element to focus first. Defaults to the dialog itself. */
  initialFocus?: () => HTMLElement | undefined;
  /** Backdrop click and Escape. */
  onDismiss: () => void;
  /** Rendered as `data-testid` on the dialog panel, and with `-backdrop` appended on the backdrop. */
  testId?: string;
  children: JSX.Element;
}

/** Where each open dialog returns focus when it closes. */
const restoreTargets = new WeakMap<Element, HTMLElement | null>();

/**
 * Where a dialog opening now returns focus. Queued dialogs open one after
 * another, and the next one opens while the last one still holds focus:
 * it inherits that dialog's target, so the queue as a whole returns focus
 * to where it was before the first dialog. Each panel carries
 * `data-dialog`, which is how the focused one is found.
 */
function restoreTargetNow(): HTMLElement | null {
  const active = document.activeElement;
  // A scrim press blurs focus to the body while the dialog is still up.
  if (active === document.body) {
    const open = document.querySelector('[data-dialog]');
    if (open !== null && restoreTargets.has(open)) {
      return restoreTargets.get(open) ?? null;
    }
  }
  if (!(active instanceof HTMLElement)) {
    return null;
  }
  const outer = active.closest('[data-dialog]');
  if (outer !== null && restoreTargets.has(outer)) {
    return restoreTargets.get(outer) ?? null;
  }
  return active;
}

/**
 * Whether a dialog opening now takes over from one still on screen: the next
 * in the queue mounts before the answered one is removed. Decided by presence,
 * not focus, since a scrim press blurs focus to the body first.
 */
function followsDialog(): boolean {
  return document.querySelector('[data-dialog]') !== null;
}

/**
 * Put focus back on `target`, or, when it left the page meanwhile, on the
 * product frame the dialog was most likely raised from, rather than let it
 * fall to the page body. Nothing to restore (focus was on the body) leaves
 * focus alone.
 */
function restoreFocus(target: HTMLElement | null): void {
  if (target === null) {
    return;
  }
  if (target.isConnected) {
    target.focus();
    return;
  }
  currentProductFrame()?.focus();
}

export function Dialog(props: DialogProps): JSX.Element {
  let backdrop!: HTMLDivElement;
  let dialog!: HTMLDivElement;
  const previouslyFocused = restoreTargetNow();
  // Read once, before this dialog is in the page: a follow-up keeps the scrim
  // still rather than fade it in again.
  const follows = followsDialog();

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      // Handled in the capture phase, ahead of any other document Escape
      // handler (e.g. a host page's own shortcut), so it never also fires.
      event.stopPropagation();
      props.onDismiss();
    } else if (event.key === 'Tab') {
      containTab(event, dialog);
    }
  };

  onSettled(() => {
    (props.initialFocus?.() ?? dialog).focus();
  });
  document.addEventListener('keydown', onKeyDown, true);
  onCleanup(() => {
    document.removeEventListener('keydown', onKeyDown, true);
    restoreFocus(previouslyFocused);
  });

  return (
    <div
      class={s['backdrop']}
      data-follows={follows ? '' : undefined}
      data-testid={props.testId === undefined ? undefined : `${props.testId}-backdrop`}
      ref={el => {
        backdrop = el;
      }}
      onClick={event => {
        if (event.target === backdrop) {
          props.onDismiss();
        }
      }}
    >
      <div
        class={s['dialog']}
        data-chrome=""
        data-dialog=""
        data-testid={props.testId}
        ref={el => {
          dialog = el;
          restoreTargets.set(el, previouslyFocused);
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={props.titleId}
        tabindex="-1"
      >
        {props.children}
      </div>
    </div>
  );
}
