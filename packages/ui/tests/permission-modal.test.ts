import { afterEach, describe, expect, it } from "vitest";
import { showPermissionRequestModal } from "@dotli/ui/permission-modal";

afterEach(() => {
  document.body.replaceChildren();
});

describe("permission request modal", () => {
  it("resolves granted when the user allows", async () => {
    const decision = showPermissionRequestModal("myapp", "Camera");

    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();

    await expect(decision).resolves.toBe("granted");
  });

  it("resolves denied when the user denies", async () => {
    const decision = showPermissionRequestModal("myapp", "Camera");

    document.querySelector<HTMLButtonElement>(".signing-btn-cancel")?.click();

    await expect(decision).resolves.toBe("denied");
  });

  it("resolves dismissed when the backdrop is clicked", async () => {
    const decision = showPermissionRequestModal("myapp", "Camera");

    document.querySelector<HTMLDivElement>(".signing-modal-backdrop")?.click();

    await expect(decision).resolves.toBe("dismissed");
  });
});
