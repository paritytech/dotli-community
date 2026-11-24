// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { children, createEffect, createSignal, createUniqueId, isHydrating, onSettled, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { isPhoneViewport, watchPhoneViewport } from '../../page/phoneViewport.js';
import { createPresence } from './createPresence.js';
import { InSheet } from './inSheet.js';
import { ModalLayer } from './ModalLayer.js';
import { SheetFrame } from './SheetFrame.js';
import { SideFrame } from './SideFrame.js';
import s from './Drawer.module.css';

export type DrawerProps = {
  open: boolean;
  /** Escape inside it, the close button or a swipe toward the edge, and on a phone a press on the scrim. */
  onOpenChange: (open: boolean) => void;
  /** Drawn in the head's heading, which names the drawer, so markup in it keeps to what a heading may hold. */
  title: JSX.Element;
  /** A trigger whose `aria-controls` names it closes the phone sheet on a press, rather than handing the sheet off. */
  id?: string | undefined;
  /** On the panel or sheet, with `-backdrop`, `-scrim`, `-side-*` and `-sheet-*` variants. */
  testId: string;
  children: JSX.Element;
};

/**
 * A panel beside the page on the right edge on wide screens, which leaves the page usable, and a modal bottom sheet on
 * a phone, following the viewport while open. The panel insets from the page's content edges.
 * Its children render from an opening until the layer's exit transition ends, and move between the forms, so a
 * field's value and focus survive the switch.
 */
export function Drawer(props: DrawerProps): JSX.Element {
  let frame: HTMLDivElement | undefined;
  // Hydration starts in the build-time wide form, which had no viewport, and takes the real one once settled.
  const [phone, setPhone] = createSignal(isHydrating() ? false : isPhoneViewport());
  // Moving between forms blurs the focused element, so it is refocused once moved.
  let focusAcross: Element | null = null;
  onSettled(() => {
    setPhone(isPhoneViewport());
    return watchPhoneViewport(next => {
      const active = document.activeElement;
      focusAcross = frame?.contains(active) === true ? active : null;
      setPhone(next);
    });
  });
  createEffect(phone, () => {
    const held = focusAcross;
    focusAcross = null;
    if (held === null || frame === undefined) {
      return;
    }
    // The head's close button is gone, so the new surface takes focus.
    const target = held.isConnected ? held : frame.querySelector('[data-modal-surface]');
    if (target instanceof HTMLElement && document.activeElement !== target) {
      target.focus();
    }
  });

  // The layer shows through its exit, so the content stays until that ends.
  const presence = createPresence({
    open: () => props.open,
    exit: { kind: 'transition', target: () => frame ?? null },
  });
  // Created under InSheet once per opening, so Surface follows the form rather than keep the one it was made in.
  const content = children(() => (
    <Show when={presence()} keyed>
      {(_opening: number) => <InSheet value={() => (phone() ? {} : undefined)}>{props.children}</InSheet>}
    </Show>
  ));
  const dismiss = (): void => {
    props.onOpenChange(false);
  };
  // Built once, so markup in the title moves between the forms as the content does.
  const title = children(() => props.title);
  const titleId = createUniqueId();

  return (
    <ModalLayer
      open={props.open}
      onDismiss={dismiss}
      id={props.id}
      testId={props.testId}
      labelledBy={titleId}
      layout={phone() ? 'sheet' : 'side'}
      ref={element => {
        frame = element;
      }}
    >
      <Show
        when={phone()}
        fallback={
          <SideFrame title={title()} titleId={titleId} onDismiss={dismiss} testId={props.testId} open={props.open}>
            {content()}
          </SideFrame>
        }
      >
        <SheetFrame
          title={title()}
          titleId={titleId}
          onDismiss={dismiss}
          testId={props.testId}
          open={props.open}
          body={{ class: s['sheetBody'] }}
        >
          {content()}
        </SheetFrame>
      </Show>
    </ModalLayer>
  );
}
