import { afterEach, describe, expect, it, vi } from "vitest";
import { createBlockingModalCoordinator } from "@dotli/ui/blocking-modal-queue";
import { createUserConfirmationAdapters } from "@dotli/ui/host-callbacks/UserConfirmation";
import { createPromptPermission } from "@dotli/ui/host-callbacks/PromptPermission";
import { createHostCallbacks } from "@dotli/ui/host-callbacks/handlers";
import { registerPermissionAuthorizationProvider } from "@dotli/ui/permissions";

afterEach(() => {
  document.body.replaceChildren();
});

describe("blocking modal queue", () => {
  it("serializes user confirmation and device permission prompts", async () => {
    const scope = createBlockingModalCoordinator().createScope();
    const callbacks = createHostCallbacks({
      label: "localhost:3000",
      blockingModalScope: scope,
    });

    const accountAccess = callbacks.userConfirmation.confirmUserAction({
      tag: "AccountAccess",
      value: {
        requestingProductId: "truapi-playground.dot",
        targetProductId: "other-product.dot",
      },
    });
    const camera = callbacks.permissions.devicePermission("Camera");

    expect(document.querySelectorAll(".signing-modal-backdrop")).toHaveLength(
      1,
    );
    expect(document.querySelector(".signing-modal h2")?.textContent).toBe(
      "Account Access",
    );

    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();
    await expect(accountAccess).resolves.toBe(true);
    await vi.waitFor(() => {
      expect(document.querySelector(".signing-modal h2")?.textContent).toBe(
        "Permission Request",
      );
    });
    expect(document.querySelectorAll(".signing-modal-backdrop")).toHaveLength(
      1,
    );

    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();
    await expect(camera).resolves.toEqual({ granted: true });
    expect(document.querySelector(".signing-modal-backdrop")).toBeNull();
    scope.dispose();
  });

  it("rechecks permission state before showing a queued duplicate", async () => {
    let status: "NotDetermined" | "Authorized" = "NotDetermined";
    const unregister = registerPermissionAuthorizationProvider("myapp", {
      async getPermissionAuthorizationStatuses(requests) {
        return requests.map(() => status);
      },
      async setPermissionAuthorizationStatus(_request, nextStatus) {
        if (nextStatus === "Authorized" || nextStatus === "NotDetermined") {
          status = nextStatus;
        }
      },
    });
    const scope = createBlockingModalCoordinator().createScope();
    const { devicePermission } = createPromptPermission("myapp", scope);

    const first = devicePermission("Notifications");
    const second = devicePermission("Notifications");
    await vi.waitFor(() => {
      expect(document.querySelectorAll(".signing-modal-backdrop")).toHaveLength(
        1,
      );
    });

    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { granted: true },
      { granted: true },
    ]);
    expect(document.querySelector(".signing-modal-backdrop")).toBeNull();
    expect(status).toBe("Authorized");
    scope.dispose();
    unregister();
  });

  it("removes a disposed host modal and advances to the next host", async () => {
    const coordinator = createBlockingModalCoordinator();
    const firstScope = coordinator.createScope();
    const secondScope = coordinator.createScope();
    const first = createUserConfirmationAdapters(
      "first",
      firstScope,
    ).confirmUserAction({
      tag: "IdentityDisclosure",
      value: { productId: "first.dot" },
    });
    const second = createUserConfirmationAdapters(
      "second",
      secondScope,
    ).confirmUserAction({
      tag: "IdentityDisclosure",
      value: { productId: "second.dot" },
    });

    expect(document.querySelector(".signing-field-value")?.textContent).toBe(
      "first.dot",
    );

    firstScope.dispose();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(document.querySelectorAll(".signing-modal-backdrop")).toHaveLength(
      1,
    );
    expect(document.querySelector(".signing-field-value")?.textContent).toBe(
      "second.dot",
    );

    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();
    await expect(second).resolves.toBe(true);
    secondScope.dispose();
  });

  it("advances after a modal task throws", async () => {
    const coordinator = createBlockingModalCoordinator();
    const firstScope = coordinator.createScope();
    const secondScope = coordinator.createScope();
    const failed = firstScope.enqueue(() => {
      throw new Error("render failed");
    });
    const completed = secondScope.enqueue(() => "next");

    await expect(failed).rejects.toThrow("render failed");
    await expect(completed).resolves.toBe("next");
    firstScope.dispose();
    secondScope.dispose();
  });

  it("rejects queued and future work when its host is disposed", async () => {
    const coordinator = createBlockingModalCoordinator();
    const activeScope = coordinator.createScope();
    const disposedScope = coordinator.createScope();
    let finishActive: (() => void) | null = null;
    const active = activeScope.enqueue(
      () =>
        new Promise<void>((resolve) => {
          finishActive = resolve;
        }),
    );
    const queued = disposedScope.enqueue(() => "queued");

    disposedScope.dispose();

    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    await expect(disposedScope.enqueue(() => "late")).rejects.toMatchObject({
      name: "AbortError",
    });
    finishActive?.();
    await active;
    activeScope.dispose();
  });
});
