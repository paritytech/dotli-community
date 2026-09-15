import { afterEach, describe, expect, it } from "vitest";
import { showPermissionRequestModal } from "@dotli/ui/permission-modal";

afterEach(() => {
  document.body.replaceChildren();
});

function dialog(): HTMLDialogElement | null {
  return document.querySelector<HTMLDialogElement>("dialog.signing-dialog");
}

describe("permission request modal", () => {
  it("As a dotli integrator, the host resolves granted when the user allows", async () => {
    // Given
    const decision = showPermissionRequestModal("myapp", "Camera");

    // When
    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();

    // Then
    await expect(decision).resolves.toBe("granted");
  });

  it("As a dotli integrator, the host resolves denied when the user denies", async () => {
    // Given
    const decision = showPermissionRequestModal("myapp", "Camera");

    // When
    document.querySelector<HTMLButtonElement>(".signing-btn-cancel")?.click();

    // Then
    await expect(decision).resolves.toBe("denied");
  });

  it("As a dotli integrator, the host resolves dismissed when the backdrop is clicked", async () => {
    // Given
    const decision = showPermissionRequestModal("myapp", "Camera");

    // When
    dialog()?.click();

    // Then
    await expect(decision).resolves.toBe("dismissed");
  });

  it("As a keyboard user, I press Escape and the prompt is dismissed without storing a decision", async () => {
    // Given
    const decision = showPermissionRequestModal("myapp", "Camera");

    // When the browser turns Escape into a cancel event on the open dialog
    dialog()?.dispatchEvent(new Event("cancel", { cancelable: true }));

    // Then
    await expect(decision).resolves.toBe("dismissed");
    expect(dialog()).toBeNull();
  });

  it("As a screen reader user, the prompt opens as a modal dialog named by its heading with focus on the safe action", async () => {
    // Given
    const decision = showPermissionRequestModal("myapp", "Camera");

    // Then
    const open = dialog();
    expect(open?.open).toBe(true);
    const titleId = open?.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(titleId)?.textContent).toBe(
      "Permission Request",
    );
    expect(document.activeElement?.textContent).toBe("Deny");

    // Cleanup
    document.querySelector<HTMLButtonElement>(".signing-btn-cancel")?.click();
    await decision;
  });

  it("As a keyboard user, focus returns to the control I was on once the prompt closes", async () => {
    // Given
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const decision = showPermissionRequestModal("myapp", "Camera");
    expect(document.activeElement).not.toBe(trigger);

    // When
    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();
    await decision;

    // Then
    expect(document.activeElement).toBe(trigger);
    expect(dialog()).toBeNull();
  });

  it("As a dotli integrator, an already aborted request never opens a dialog", async () => {
    // Given
    const controller = new AbortController();
    controller.abort(new DOMException("gone", "AbortError"));

    // When
    const decision = showPermissionRequestModal(
      "myapp",
      "Camera",
      controller.signal,
    );

    // Then
    await expect(decision).rejects.toThrow("gone");
    expect(dialog()).toBeNull();
  });
});
