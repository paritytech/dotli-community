// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Shared dialog shell: the scrim and the glass card (a bottom sheet while the
// viewport is a phone's, in the shared frame of components/sheet, led by the
// sheets' head), dialog semantics, initial focus, a Tab trap, Escape, and
// focus restored on close. Its layout parts (DialogHead, DialogBody,
// DialogActions) draw the board's modal inside it.

import { createSignal, onCleanup, onSettled, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { isPhoneViewport, watchPhoneViewport } from '../../phone-viewport.js';
import { currentProductFrame } from '../../product-frame-layout.js';
import { containTab, lockScroll } from '../focus.js';
import { SheetHead } from '../sheet/SheetHead.js';
import frame from '../sheet/Sheet.module.css';
import { IconTile } from './IconTile.js';
import s from './Dialog.module.css';

export interface DialogProps {
  titleId: string;
  /** The phone sheet head's title. */
  title: string;
  /** Element to focus first. Defaults to the dialog itself. */
  initialFocus?: () => HTMLElement | undefined;
  /** Backdrop click and Escape. */
  onDismiss: () => void;
  /** The phone sheet head's close button and swipe. */
  onClose: () => void;
  /**
   * Rendered as `data-testid` on the dialog panel, and with `-backdrop`,
   * `-sheet-head`, `-sheet-title` and `-sheet-close` appended on those parts.
   */
  testId: string;
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
  // Read as it mounts, so a sheet slides in from its first frame, then
  // followed: a dialog open across a resize takes the other form. A dialog
  // is mounted only while open, so its `data-open`, which the frame's slide
  // keys on, never goes.
  const [sheet, setSheet] = createSignal(isPhoneViewport());
  onCleanup(watchPhoneViewport(setSheet));

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
  // The page stays put under the scrim, as under createPopover's dialogs. A
  // queued follow-up takes its lock before this one lets go, so it holds.
  const unlockScroll = lockScroll();
  onCleanup(() => {
    document.removeEventListener('keydown', onKeyDown, true);
    unlockScroll();
    restoreFocus(previouslyFocused);
  });

  return (
    <div
      class={s['backdrop']}
      data-follows={follows ? '' : undefined}
      data-sheet={sheet() ? '' : undefined}
      data-testid={`${props.testId}-backdrop`}
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
        class={[s['dialog'], frame['sheet']]}
        data-chrome=""
        data-dialog=""
        data-open=""
        data-sheet={sheet() ? '' : undefined}
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
        <Show when={sheet()}>
          <SheetHead
            title={props.title}
            surface={() => dialog}
            onDismiss={props.onClose}
            closeLabel="Close"
            testId={`${props.testId}-sheet-head`}
            titleTestId={`${props.testId}-sheet-title`}
            closeTestId={`${props.testId}-sheet-close`}
          />
        </Show>
        <div class={[s['content'], sheet() && frame['body']]}>{props.children}</div>
      </div>
    </div>
  );
}

/**
 * The icon tile over the centred title. Phones drop it, as the sheet head
 * carries the title there.
 */
export function DialogHead(props: {
  /** The dialog's `titleId`, which labels it. */
  titleId: string;
  title: string;
  /** Trusted SVG markup for the IconTile. */
  icon?: string | undefined;
  iconTestId?: string;
}): JSX.Element {
  return (
    <div class={s['head']}>
      <Show when={props.icon}>{icon => <IconTile markup={icon()} testId={props.iconTestId} />}</Show>
      <h2 class={s['title']} id={props.titleId}>
        {props.title}
      </h2>
    </div>
  );
}

/** Between the head and the answers, the part that scrolls when it outgrows the window. */
export function DialogBody(props: { children: JSX.Element }): JSX.Element {
  return <div class={s['body']}>{props.children}</div>;
}

/** The row of equal-width answers, stacked on phones. Each child is one answer. */
export function DialogActions(props: { testId?: string; children: JSX.Element }): JSX.Element {
  return (
    <div class={s['actions']} data-testid={props.testId}>
      {props.children}
    </div>
  );
}
