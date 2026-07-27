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
});
