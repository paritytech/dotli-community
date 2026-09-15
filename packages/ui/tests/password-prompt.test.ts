import { afterEach, describe, expect, it } from "vitest";
import { showPasswordPrompt } from "@dotli/ui/password-prompt";

afterEach(() => {
  document.body.replaceChildren();
});

function dialog(): HTMLDialogElement | null {
  return document.querySelector<HTMLDialogElement>("dialog.signing-dialog");
}

function input(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(".password-prompt-input");
}

describe("password prompt", () => {
  it("As a user, the prompt opens as a modal dialog with the password field focused", async () => {
    // Given
    const password = showPasswordPrompt();

    // Then
    expect(dialog()?.open).toBe(true);
    expect(document.activeElement).toBe(input());
    expect(
      document.getElementById(dialog()?.getAttribute("aria-labelledby") ?? "")
        ?.textContent,
    ).toBe("Encrypted Content");

    // Cleanup
    document.querySelector<HTMLButtonElement>(".signing-btn-cancel")?.click();
    await expect(password).rejects.toThrow("User cancelled decryption");
  });

  it("As a user, Enter submits the password I typed", async () => {
    // Given
    const password = showPasswordPrompt();
    const field = input();

    // When
    if (field !== null) {
      field.value = "hunter2";
      field.dispatchEvent(new Event("input"));
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    }

    // Then
    await expect(password).resolves.toBe("hunter2");
    expect(dialog()).toBeNull();
  });

  it("As a keyboard user, Escape cancels decryption", async () => {
    // Given
    const password = showPasswordPrompt();

    // When the browser turns Escape into a cancel event on the open dialog
    dialog()?.dispatchEvent(new Event("cancel", { cancelable: true }));

    // Then
    await expect(password).rejects.toThrow("User cancelled decryption");
    expect(dialog()).toBeNull();
  });

  it("As a user, clicking the backdrop keeps the prompt open because there is no content to fall back to", async () => {
    // Given
    const password = showPasswordPrompt({ error: "Wrong password" });

    // When
    dialog()?.click();

    // Then
    expect(dialog()?.open).toBe(true);
    expect(document.querySelector(".password-prompt-error")?.textContent).toBe(
      "Wrong password",
    );

    // Cleanup
    document.querySelector<HTMLButtonElement>(".signing-btn-cancel")?.click();
    await expect(password).rejects.toThrow("User cancelled decryption");
  });
});
