// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li native <dialog> wrapper for blocking modals
//
// showModal() puts the dialog in the top layer, makes the rest of the page
// inert, keeps Tab inside it, closes on Escape and exposes dialog semantics
// to assistive tech. This adds what the platform leaves to the page: the
// accessible name, initial focus, backdrop dismissal and focus restoration.

let generatedIds = 0;

function ensureId(element: HTMLElement, prefix: string): string {
  if (element.id === "") {
    generatedIds += 1;
    element.id = `${prefix}-${String(generatedIds)}`;
  }
  return element.id;
}

export interface ModalDialogOptions {
  /** Class on the <dialog> element; also selects its ::backdrop. */
  dialogClass: string;
  /** Heading the dialog is announced by. */
  title: HTMLElement;
  /** Body content read after the title. */
  description?: HTMLElement;
  /** Receives focus once open. Defaults to the dialog element itself. */
  initialFocus?: HTMLElement;
  /** Escape, or a platform back gesture, asked the dialog to close. */
  onCancel: () => void;
  /** A click landed on the ::backdrop. Omit to keep such clicks inert. */
  onBackdropClick?: () => void;
}

export interface ModalDialogHandle {
  readonly dialog: HTMLDialogElement;
  /** Close, unmount, and hand focus back to where it was before opening. */
  close(): void;
}

/**
 * Mount `panel` inside a modal <dialog> appended to the body and open it.
 * The dialog has no padding, so a click whose target is the dialog itself
 * can only have landed on the backdrop.
 */
export function openModalDialog(
  panel: HTMLElement,
  options: ModalDialogOptions,
): ModalDialogHandle {
  const dialog = document.createElement("dialog");
  dialog.className = options.dialogClass;
  dialog.tabIndex = -1;
  dialog.setAttribute(
    "aria-labelledby",
    ensureId(options.title, "dotli-dialog-title"),
  );
  if (options.description !== undefined) {
    dialog.setAttribute(
      "aria-describedby",
      ensureId(options.description, "dotli-dialog-description"),
    );
  }
  dialog.appendChild(panel);

  const previouslyFocused = document.activeElement;
  let closed = false;

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    if (dialog.open) {
      dialog.close();
    }
    dialog.remove();
    if (
      previouslyFocused instanceof HTMLElement &&
      previouslyFocused !== document.body &&
      previouslyFocused.isConnected
    ) {
      previouslyFocused.focus();
    }
  };

  dialog.addEventListener("cancel", () => {
    options.onCancel();
  });
  // The browser closed the dialog without a cancel round trip (older
  // engines skip it after a prevented cancel). Treat it like one.
  dialog.addEventListener("close", () => {
    if (!closed) {
      close();
      options.onCancel();
    }
  });
  if (options.onBackdropClick !== undefined) {
    const onBackdropClick = options.onBackdropClick;
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) {
        onBackdropClick();
      }
    });
  }

  document.body.appendChild(dialog);
  dialog.showModal();
  (options.initialFocus ?? dialog).focus();

  return { dialog, close };
}
