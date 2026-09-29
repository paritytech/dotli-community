// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Password prompt modal for encrypted SPAs
//
// Asks the user for a decryption password. Clicking the backdrop does not
// dismiss it: encrypted content has no fallback to show, so the user must
// cancel or submit. Rendered by the overlays root.

import { ERRORS } from "./errors.js";
import { presentModal } from "./overlays/load.js";

const LOCK_SVG =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>' +
  '<path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

/**
 * Show a password prompt modal. Resolves with the entered password,
 * or rejects if the user cancels.
 */
export async function showPasswordPrompt(opts?: {
  error?: string;
}): Promise<string> {
  const outcome = await presentModal<"cancel" | "unlock">({
    icon: LOCK_SVG,
    title: "Encrypted Content",
    fields: [],
    input: {
      kind: "password",
      placeholder: "Password",
      hint: "This content is password-protected. Enter the password to decrypt.",
      ...(opts?.error !== undefined && opts.error !== ""
        ? { error: opts.error }
        : {}),
    },
    buttons: [
      { label: "Cancel", variant: "cancel", result: "cancel" },
      { label: "Unlock", variant: "primary", result: "unlock" },
    ],
    dismissOnBackdrop: false,
    fallbackResult: "cancel",
  });
  if (
    outcome.result !== "unlock" ||
    outcome.value === undefined ||
    outcome.value === ""
  ) {
    throw new Error(ERRORS.DECRYPTION_CANCELLED);
  }
  return outcome.value;
}
