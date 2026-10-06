// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { children, createEffect, createSignal, onCleanup, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { isPhoneViewport, watchPhoneViewport } from '../../phone-viewport.js';
import { IconTile } from '../primitives/IconTile.js';
import { InSheet } from './in-sheet.js';
import { ModalLayer } from './ModalLayer.js';
import { SheetFrame } from './SheetFrame.js';
import s from './Modal.module.css';

export interface ModalProps {
  open: boolean;
  /** `dismiss`: Escape or the scrim. `close`: the sheet head's close button or a swipe. */
  onOpenChange: (open: boolean, reason?: 'dismiss' | 'close') => void;
  /** The sheet head's title, and the name when nothing labels the card. */
  title: string;
  labelledBy?: string | undefined;
  initialFocus?: (() => HTMLElement | undefined) | undefined;
  /** Where focus returns on close instead of what held it at opening (a trigger the browser may not focus on click). */
  restoreFocus?: (() => HTMLElement | undefined) | undefined;
  placement?: 'center' | 'topbar-end';
  scrim?: 'dark' | 'light';
  id?: string | undefined;
  /** The card's own class (the auth modal's glass and width). */
  class?: string | undefined;
  /** On the card or sheet; the frame gets -backdrop, the scrim -scrim, the sheet head -sheet-head, -sheet-title, -sheet-close. */
  testId: string;
  /** Receives the dialog frame (AuthModal registers it as a topbar surface). */
  frameRef?: (el: HTMLDialogElement) => void;
  children: JSX.Element;
}

/**
 * A modal: a card (centred, or under the topbar's end) on wide screens and
 * a bottom sheet on a phone's, following the viewport while open. The
 * children are resolved once and moved between the two forms, so a field's
 * value and focus survive the switch.
 */
function ModalRoot(props: ModalProps): JSX.Element {
  let frame: HTMLDialogElement | undefined;
  // Read as it mounts, so a phone opening is a sheet from its first frame.
  const [phone, setPhone] = createSignal(isPhoneViewport());
  // A focused element is blurred as it moves between forms: what held focus
  // in the dialog as the viewport crossed, given focus again once moved.
  let focusAcross: Element | null = null;
  onCleanup(
    watchPhoneViewport(next => {
      const active = document.activeElement;
      focusAcross = frame?.contains(active) === true ? active : null;
      setPhone(next);
    }),
  );
  createEffect(phone, () => {
    const held = focusAcross;
    focusAcross = null;
    if (held === null || frame === undefined) {
      return;
    }
    // The card itself, or the sheet head's close, is gone: the new surface.
    const target = held.isConnected ? held : frame.querySelector('[data-modal-surface]');
    if (target instanceof HTMLElement && document.activeElement !== target) {
      target.focus();
    }
  });

  // Created under InSheet once, so content that lays out as a sheet (Surface)
  // follows the form as it moves rather than keep the one it was made in.
  const content = children(() => <InSheet value={phone}>{props.children}</InSheet>);
  const layout = (): 'center' | 'sheet' | 'topbar-end' => (phone() ? 'sheet' : (props.placement ?? 'center'));

  return (
    <ModalLayer
      open={props.open}
      onDismiss={() => {
        props.onOpenChange(false, 'dismiss');
      }}
      id={props.id}
      testId={props.testId}
      label={props.title}
      labelledBy={props.labelledBy}
      initialFocus={props.initialFocus}
      restoreFocus={props.restoreFocus}
      scrim={props.scrim}
      layout={layout}
      ref={el => {
        frame = el;
        props.frameRef?.(el);
      }}
    >
      <Show
        when={phone()}
        fallback={
          <div
            class={[s['card'], props.class]}
            data-modal-surface=""
            data-testid={props.testId}
            data-placement={props.placement ?? 'center'}
            tabindex="-1"
          >
            {content()}
          </div>
        }
      >
        <SheetFrame
          title={props.title}
          onDismiss={() => {
            props.onOpenChange(false, 'close');
          }}
          testId={props.testId}
          closeLabel="Close"
          body={{ class: s['sheetScroll'] }}
        >
          <div class={s['sheetBody']}>{content()}</div>
        </SheetFrame>
      </Show>
    </ModalLayer>
  );
}

/**
 * The icon tile over the centred title. The sheet drops it, as its head
 * carries the title there.
 */
function Head(props: {
  /** The modal's `labelledBy`, which this title is. */
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
function Body(props: { children: JSX.Element }): JSX.Element {
  return <div class={s['body']}>{props.children}</div>;
}

/** The row of equal-width answers, stacked in the sheet. Each child is one answer. */
function Actions(props: { testId?: string; children: JSX.Element }): JSX.Element {
  return (
    <div class={s['actions']} data-testid={props.testId}>
      {props.children}
    </div>
  );
}

export const Modal = Object.assign(ModalRoot, { Head, Body, Actions });
