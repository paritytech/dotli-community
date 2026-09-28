import { afterEach, describe, expect, it } from "vitest";
import { showPermissionRequestModal } from "@dotli/ui/permission-modal";

afterEach(() => {
  document.body.replaceChildren();
});

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
    document.querySelector<HTMLDivElement>(".signing-modal-backdrop")?.click();

    // Then
    await expect(decision).resolves.toBe("dismissed");
  });

  it("As a dotli user, a two-way prompt offers Deny and Allow", () => {
    // When
    void showPermissionRequestModal("myapp", "Camera");

    // Then
    expect(footerButtons()).toEqual([
      { text: "Deny", className: "signing-btn-cancel" },
      { text: "Allow", className: "signing-btn-sign" },
    ]);
  });

  it("As a dotli user, a three-way prompt highlights Allow once", () => {
    // When
    void showPermissionRequestModal("myapp", "ChainSubmit", undefined, {
      allowOnce: true,
    });

    // Then
    expect(footerButtons()).toEqual([
      { text: "Deny", className: "signing-btn-cancel" },
      { text: "Always allow", className: "signing-btn-secondary" },
      { text: "Allow once", className: "signing-btn-sign" },
    ]);
  });

  it("As a dotli user, choosing Allow once resolves a one-time grant", async () => {
    // Given
    const decision = showPermissionRequestModal(
      "myapp",
      "ChainSubmit",
      undefined,
      { allowOnce: true },
    );

    // When
    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();

    // Then
    await expect(decision).resolves.toBe("granted-once");
  });

  it("As a dotli user, choosing Always allow resolves a lasting grant", async () => {
    // Given
    const decision = showPermissionRequestModal(
      "myapp",
      "ChainSubmit",
      undefined,
      { allowOnce: true },
    );

    // When
    document
      .querySelector<HTMLButtonElement>(".signing-btn-secondary")
      ?.click();

    // Then
    await expect(decision).resolves.toBe("granted");
  });
});

function footerButtons(): { text: string; className: string }[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      ".signing-modal-footer button",
    ),
    (button) => ({
      text: button.textContent ?? "",
      className: button.className,
    }),
  );
}
