// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@dotli/metrics/sentry", () => sentry);

import {
  presentModal,
  presentToast,
  prefetchOverlays,
} from "@dotli/ui/overlays/load";
import { toastsStore } from "@dotli/ui/state/toasts";
import type { ModalView } from "@dotli/ui/state/modals";
import { overlaysReady, resetOverlays } from "../helpers/overlays";

const VIEW: ModalView<"no" | "yes" | "dismissed"> = {
  title: "Question",
  fields: [],
  buttons: [
    { label: "No", variant: "cancel", result: "no" },
    { label: "Yes", variant: "primary", result: "yes" },
  ],
  dismissOnBackdrop: true,
  dismissResult: "dismissed",
  fallbackResult: "dismissed",
};

afterEach(() => {
  resetOverlays();
  vi.unstubAllGlobals();
  vi.doUnmock("@dotli/ui/components/overlays/mount");
  sentry.captureException.mockReset();
  document.body.replaceChildren();
});

describe("overlays loader", () => {
  it("As a dotli user, a toast pushed before the overlays mount appears once they do", async () => {
    // Given
    presentToast({
      text: "Boot banner",
      label: "Hello",
      icon: "<svg></svg>",
      dismissMs: 0,
    });
    expect(document.querySelector(".notif-card")).toBeNull();

    // When
    await overlaysReady();

    // Then
    expect(
      document.querySelector("#overlay-root .notif-title")?.textContent,
    ).toBe("Hello");
  });

  it("As a dotli user, a dialog renders into the overlay root and settles from its buttons", async () => {
    // Given
    const outcome = presentModal(VIEW);
    await overlaysReady();

    // When
    document
      .querySelector<HTMLButtonElement>("#overlay-root .signing-btn-sign")
      ?.click();

    // Then
    await expect(outcome).resolves.toEqual({ result: "yes" });
  });

  it("As a dotli integrator, an aborted signal rejects before anything renders or loads", async () => {
    // Given
    const controller = new AbortController();
    controller.abort();

    // When
    const outcome = presentModal(VIEW, controller.signal);

    // Then
    await expect(outcome).rejects.toMatchObject({ name: "AbortError" });
    expect(document.getElementById("overlay-root")).toBeNull();
  });

  it("As a dotli integrator, aborting while the overlays are still loading never shows the dialog", async () => {
    // Given
    const controller = new AbortController();
    const outcome = presentModal(VIEW, controller.signal);
    // Rejects synchronously inside abort() below, well before the `await
    // overlaysReady()` gap; a silent catch here keeps Node from flagging it
    // as unhandled in that gap. The real assertion is the `.rejects` below.
    outcome.catch(() => undefined);

    // When
    controller.abort();
    await overlaysReady();

    // Then
    await expect(outcome).rejects.toMatchObject({ name: "AbortError" });
    expect(document.querySelector(".signing-modal-backdrop")).toBeNull();
  });

  it("As a dotli user, prefetching mounts the overlays when the browser is idle", async () => {
    // Given
    const idle = vi.fn((cb: () => void) => {
      cb();
      return 1;
    });
    vi.stubGlobal("requestIdleCallback", idle);

    // When
    prefetchOverlays();
    await overlaysReady();

    // Then
    expect(idle).toHaveBeenCalledTimes(1);
    expect(document.getElementById("overlay-root")).not.toBeNull();
  });

  it("As a dotli user, when the overlay code cannot load, action toasts fall back to a confirm and dialogs settle with their fallback", async () => {
    // Given
    vi.resetModules();
    vi.doMock("@dotli/ui/components/overlays/mount", () => {
      throw new Error("chunk failed");
    });
    const load = await import("@dotli/ui/overlays/load");
    const toasts = await import("@dotli/ui/state/toasts");
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    const onClick = vi.fn();
    load.presentToast({
      text: "A new version may have been deployed.",
      label: "Asset failed to load",
      icon: "<svg></svg>",
      dismissMs: 0,
      action: { label: "Reload", onClick },
    });
    load.presentToast({
      text: "Plain",
      label: "Info",
      icon: "<svg></svg>",
      dismissMs: 0,
    });
    const outcome = load.presentModal(VIEW);

    // When
    await load.ensureOverlays();

    // Then
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      kind: "overlays_load_error",
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(
      "Asset failed to load\n\nA new version may have been deployed.",
    );
    expect(onClick).toHaveBeenCalledTimes(1);
    await expect(outcome).resolves.toEqual({ result: "dismissed" });
    expect(toasts.toastsStore.get().items).toEqual([]);
  });

  it("As a dotli user, the overlays keep the toast store in sync with what is shown", async () => {
    // Given
    presentToast({
      text: "One",
      label: "A",
      icon: "<svg></svg>",
      dismissMs: 0,
    });

    // When
    await overlaysReady();

    // Then
    expect(toastsStore.get().items.map((t) => t.label)).toEqual(["A"]);
  });
});
