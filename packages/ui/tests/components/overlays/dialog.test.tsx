// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@solidjs/testing-library";
import { ModalOutlet } from "@dotli/ui/components/overlays/ModalOutlet";
import {
  openModal,
  resetModalsForTests,
  type ModalView,
} from "@dotli/ui/state/modals";
import { renderComponent, settle } from "../../helpers/solid";

type Choice = "deny" | "allow" | "once" | "dismissed";

function permissionLike(
  overrides: Partial<ModalView<Choice>> = {},
): ModalView<Choice> {
  return {
    title: "Permission Request",
    icon: '<svg data-testid="icon"></svg>',
    fields: [
      { label: "Application", value: "myapp.dot" },
      { label: "Call Data", value: "0x1234", mono: true },
      { label: "Warning", value: "Careful", warning: true },
    ],
    notice: "Granting this permission will reload the application.",
    buttons: [
      { label: "Deny", variant: "cancel", result: "deny" },
      { label: "Always allow", variant: "secondary", result: "allow" },
      { label: "Allow once", variant: "primary", result: "once" },
    ],
    dismissOnBackdrop: true,
    dismissResult: "dismissed",
    fallbackResult: "dismissed",
    ...overrides,
  };
}

function passwordView(error?: string): ModalView<"cancel" | "unlock"> {
  return {
    title: "Encrypted Content",
    fields: [],
    input: {
      kind: "password",
      placeholder: "Password",
      hint: "Enter the password to decrypt.",
      ...(error === undefined ? {} : { error }),
    },
    buttons: [
      { label: "Cancel", variant: "cancel", result: "cancel" },
      { label: "Unlock", variant: "primary", result: "unlock" },
    ],
    dismissOnBackdrop: false,
    fallbackResult: "cancel",
  };
}

async function mountOutlet(): Promise<void> {
  renderComponent(() => <ModalOutlet />);
  await settle();
}

afterEach(() => {
  resetModalsForTests();
  document.body.replaceChildren();
});

describe("signing dialog", () => {
  it("As a dotli user, a dialog shows today's markup, labels and dialog semantics", async () => {
    // Given
    void openModal(permissionLike());

    // When
    await mountOutlet();

    // Then
    const modal = document.querySelector<HTMLElement>(
      ".signing-modal-backdrop > .signing-modal",
    );
    expect(modal).not.toBeNull();
    expect(modal?.getAttribute("role")).toBe("dialog");
    expect(modal?.getAttribute("aria-modal")).toBe("true");
    const title = modal?.querySelector("h2");
    expect(title?.textContent).toBe("Permission Request");
    expect(modal?.getAttribute("aria-labelledby")).toBe(title?.id);
    expect(modal?.querySelector(".permission-modal-icon svg")).not.toBeNull();
    expect(
      [...document.querySelectorAll(".signing-fields > .signing-field")].map(
        (f) => f.className,
      ),
    ).toEqual([
      "signing-field",
      "signing-field",
      "signing-field signing-field-warning",
    ]);
    expect(
      document.querySelector(".signing-field-value.mono")?.textContent,
    ).toBe("0x1234");
    expect(
      document.querySelector(".permission-modal-notice")?.textContent,
    ).toBe("Granting this permission will reload the application.");
    expect(
      [...document.querySelectorAll(".signing-modal-footer button")].map(
        (b) => [b.textContent, b.className],
      ),
    ).toEqual([
      ["Deny", "signing-btn-cancel"],
      ["Always allow", "signing-btn-secondary"],
      ["Allow once", "signing-btn-sign"],
    ]);
  });

  it("As a dotli user, clicking a button settles the dialog with that button's result and closes it", async () => {
    // Given
    const outcome = openModal(permissionLike());
    await mountOutlet();

    // When
    fireEvent.click(
      document.querySelector<HTMLButtonElement>(".signing-btn-secondary")!,
    );
    await settle();

    // Then
    await expect(outcome).resolves.toEqual({ result: "allow" });
    expect(document.querySelector(".signing-modal-backdrop")).toBeNull();
  });

  it("As a dotli user, the backdrop and Escape dismiss a dialog that allows it, and a click inside does not", async () => {
    // Given
    const first = openModal(permissionLike());
    const second = openModal(permissionLike({ title: "Second" }));
    await mountOutlet();

    // When
    fireEvent.click(document.querySelector<HTMLElement>(".signing-modal")!);
    await settle();

    // Then
    expect(document.querySelector("h2")?.textContent).toBe(
      "Permission Request",
    );

    // When
    fireEvent.click(
      document.querySelector<HTMLElement>(".signing-modal-backdrop")!,
    );
    await settle();

    // Then
    await expect(first).resolves.toEqual({ result: "dismissed" });
    expect(document.querySelector("h2")?.textContent).toBe("Second");

    // When
    fireEvent.keyDown(document, { key: "Escape" });
    await settle();

    // Then
    await expect(second).resolves.toEqual({ result: "dismissed" });
  });

  it("As a dotli user, Escape does not also reach another document keydown listener", async () => {
    // Given
    void openModal(permissionLike());
    await mountOutlet();
    const modal = document.querySelector<HTMLElement>(".signing-modal")!;
    const bubbleListener = vi.fn();
    document.addEventListener("keydown", bubbleListener);

    // When
    fireEvent.keyDown(modal, { key: "Escape" });
    await settle();

    // Then
    expect(bubbleListener).not.toHaveBeenCalled();
    expect(document.querySelector(".signing-modal-backdrop")).toBeNull();
    document.removeEventListener("keydown", bubbleListener);
  });

  it("As a dotli user, the backdrop and Escape do nothing on a dialog that must be answered", async () => {
    // Given
    let settled = false;
    void openModal(passwordView()).then(() => {
      settled = true;
    });
    await mountOutlet();

    // When
    fireEvent.click(
      document.querySelector<HTMLElement>(".signing-modal-backdrop")!,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    await settle();

    // Then
    expect(settled).toBe(false);
    expect(document.querySelector(".signing-modal-backdrop")).not.toBeNull();
  });

  it("As a dotli user, focus starts on the dialog, not on the approve button, and Tab stays inside", async () => {
    // Given
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    void openModal(permissionLike());

    // When
    await mountOutlet();

    // Then
    const modal = document.querySelector<HTMLElement>(".signing-modal")!;
    expect(document.activeElement).toBe(modal);
    const buttons = [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".signing-modal-footer button",
      ),
    ];

    // When
    buttons[2].focus();
    fireEvent.keyDown(document, { key: "Tab" });

    // Then
    expect(document.activeElement).toBe(buttons[0]);

    // When
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });

    // Then
    expect(document.activeElement).toBe(buttons[2]);
  });

  it("As a dotli user, focus goes back to where it was when the dialog closes", async () => {
    // Given
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    void openModal(permissionLike());
    await mountOutlet();

    // When
    fireEvent.click(
      document.querySelector<HTMLButtonElement>(".signing-btn-cancel")!,
    );
    await settle();

    // Then
    expect(document.activeElement).toBe(opener);
  });

  it("As a dotli user, the password field gets focus, Unlock waits for input, and Enter submits it", async () => {
    // Given
    const outcome = openModal(passwordView("Wrong password"));
    await mountOutlet();
    const input = document.querySelector<HTMLInputElement>(
      "input.password-prompt-input",
    )!;
    const unlock =
      document.querySelector<HTMLButtonElement>(".signing-btn-sign")!;

    // Then
    expect(document.activeElement).toBe(input);
    expect(input.type).toBe("password");
    expect(input.placeholder).toBe("Password");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
    expect(document.querySelector(".password-prompt-error")?.textContent).toBe(
      "Wrong password",
    );
    expect(unlock.disabled).toBe(true);

    // When
    fireEvent.keyDown(input, { key: "Enter" });
    await settle();

    // Then
    expect(document.querySelector(".signing-modal-backdrop")).not.toBeNull();

    // When
    fireEvent.input(input, { target: { value: "hunter2" } });
    await settle();

    // Then
    expect(unlock.disabled).toBe(false);

    // When
    fireEvent.keyDown(input, { key: "Enter" });
    await settle();

    // Then
    await expect(outcome).resolves.toEqual({
      result: "unlock",
      value: "hunter2",
    });
  });

  it("As a dotli user, Cancel on the password dialog settles without the typed value", async () => {
    // Given
    const outcome = openModal(passwordView());
    await mountOutlet();
    fireEvent.input(
      document.querySelector<HTMLInputElement>("input.password-prompt-input")!,
      {
        target: { value: "typed" },
      },
    );
    await settle();

    // When
    fireEvent.click(
      document.querySelector<HTMLButtonElement>(".signing-btn-cancel")!,
    );
    await settle();

    // Then
    await expect(outcome).resolves.toEqual({ result: "cancel" });
  });

  it("As a dotli user, the next queued dialog gets focus after the first one closes", async () => {
    // Given
    void openModal(permissionLike());
    void openModal(permissionLike({ title: "Second" }));
    await mountOutlet();

    // When
    fireEvent.click(
      document.querySelector<HTMLButtonElement>(".signing-btn-cancel")!,
    );
    await settle();

    // Then
    expect(document.querySelector("h2")?.textContent).toBe("Second");
    expect(document.activeElement).toBe(
      document.querySelector(".signing-modal"),
    );
  });
});
