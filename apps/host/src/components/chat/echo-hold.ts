// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The product echoes each edit of a text field after a round trip, so a stale echo can land mid-typing.
// It is held until the user pauses, and applied only where it differs, so an agreeing echo keeps the caret.

/** How long after the last keystroke product text for a focused field is held back. */
const TYPING_HOLD_MS = 1000;

/** The text field as the hold sees it. */
export interface EchoField {
  /** What the field shows now. */
  value: () => string;
  /** Replaces what it shows, which moves the caret. */
  write: (text: string) => void;
  isFocused: () => boolean;
}

export interface EchoHold {
  /** The product's text for the field, applied now or held while the user types. */
  receive: (text: string) => void;
  /** The user typed a key. */
  typed: () => void;
  /** Starts afresh with `text` as the product's, as for another field, forgetting typing and anything held. */
  reset: (text: string) => void;
  dispose: () => void;
}

export function createEchoHold(field: EchoField): EchoHold {
  // The product text last seen, applied or held.
  let written: string | undefined;
  // Product text that arrived while the user was typing.
  let held: string | undefined;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let lastTypedAt = Number.NEGATIVE_INFINITY;

  const apply = (text: string): void => {
    if (field.value() !== text) {
      field.write(text);
    }
  };
  const dropHeld = (): void => {
    held = undefined;
    if (holdTimer !== undefined) {
      clearTimeout(holdTimer);
      holdTimer = undefined;
    }
  };
  const settleHeld = (): void => {
    holdTimer = undefined;
    if (held === undefined) {
      return;
    }
    const wait = lastTypedAt + TYPING_HOLD_MS - Date.now();
    if (wait > 0 && field.isFocused()) {
      holdTimer = setTimeout(settleHeld, wait);
      return;
    }
    const text = held;
    held = undefined;
    apply(text);
  };

  return {
    receive: text => {
      if (text === written) {
        return;
      }
      written = text;
      if (field.isFocused() && Date.now() - lastTypedAt < TYPING_HOLD_MS) {
        held = text;
        holdTimer ??= setTimeout(settleHeld, lastTypedAt + TYPING_HOLD_MS - Date.now());
        return;
      }
      dropHeld();
      apply(text);
    },
    typed: () => {
      lastTypedAt = Date.now();
    },
    reset: text => {
      dropHeld();
      lastTypedAt = Number.NEGATIVE_INFINITY;
      written = text;
    },
    dispose: dropHeld,
  };
}
