// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Shared dialog shell: backdrop, dialog semantics, initial focus, a Tab trap,
// Escape, and focus restored on close.

import { onCleanup, onSettled } from "solid-js";
import type { JSX } from "@solidjs/web";

export interface DialogProps {
  titleId: string;
  /** Element to focus first. Defaults to the dialog itself. */
  initialFocus?: () => HTMLElement | undefined;
  /** Backdrop click and Escape. */
  onDismiss: () => void;
  children: JSX.Element;
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function trapTab(event: KeyboardEvent, dialog: HTMLElement): void {
  const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (items.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === dialog)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  } else if (!dialog.contains(active)) {
    event.preventDefault();
    first.focus();
  }
}

export function Dialog(props: DialogProps): JSX.Element {
  let backdrop!: HTMLDivElement;
  let dialog!: HTMLDivElement;
  const previouslyFocused =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onDismiss();
    } else if (event.key === "Tab") {
      trapTab(event, dialog);
    }
  };

  onSettled(() => {
    (props.initialFocus?.() ?? dialog).focus();
  });
  document.addEventListener("keydown", onKeyDown);
  onCleanup(() => {
    document.removeEventListener("keydown", onKeyDown);
    if (previouslyFocused?.isConnected === true) {
      previouslyFocused.focus();
    }
  });

  return (
    <div
      class="signing-modal-backdrop"
      ref={(el) => {
        backdrop = el;
      }}
      onClick={(event) => {
        if (event.target === backdrop) {
          props.onDismiss();
        }
      }}
    >
      <div
        class="signing-modal"
        ref={(el) => {
          dialog = el;
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
