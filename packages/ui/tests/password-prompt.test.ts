// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from "vitest";
import { showPasswordPrompt } from "@dotli/ui/password-prompt";
import { ERRORS } from "@dotli/ui/errors";
import { failAllModals } from "@dotli/ui/state/modals";
import { settle } from "./helpers/solid";
import { overlaysReady, resetOverlays } from "./helpers/overlays";
import { query } from "./support";

afterEach(() => {
  resetOverlays();
  document.body.replaceChildren();
});

function type(value: string): void {
  const input = query(
    document,
    "input.password-prompt-input",
    HTMLInputElement,
  );
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("password prompt", () => {
  it("As a dotli user, I see the encrypted-content prompt and unlock with my password", async () => {
    // Given
    const password = showPasswordPrompt();
    await overlaysReady();

    // Then
    expect(document.querySelector(".signing-modal h2")?.textContent).toBe(
      "Encrypted Content",
    );
    expect(document.querySelector(".permission-modal-icon svg")).not.toBeNull();
    expect(
      document.querySelector(".signing-fields > .signing-field-value")
        ?.textContent,
    ).toBe(
      "This content is password-protected. Enter the password to decrypt.",
    );
    expect(document.querySelector(".password-prompt-error")).toBeNull();

    // When
    type("hunter2");
    await settle();
    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();

    // Then
    await expect(password).resolves.toBe("hunter2");
  });

  it("As a dotli user who typed a wrong password, I see the error and can cancel", async () => {
    // Given
    const password = showPasswordPrompt({ error: "Wrong password" });
    await overlaysReady();

    // Then
    expect(document.querySelector(".password-prompt-error")?.textContent).toBe(
      "Wrong password",
    );

    // When
    document.querySelector<HTMLButtonElement>(".signing-btn-cancel")?.click();

    // Then
    await expect(password).rejects.toThrow(ERRORS.DECRYPTION_CANCELLED);
  });

  it("As a dotli user, if the prompt cannot be shown the sandbox gets a cancellation", async () => {
    // Given
    const password = showPasswordPrompt();

    // When
    failAllModals();

    // Then
    await expect(password).rejects.toThrow(ERRORS.DECRYPTION_CANCELLED);
  });
});
