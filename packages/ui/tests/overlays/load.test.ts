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
    expect(
      document.querySelector("#overlay-root .notif-title")?.textContent,
    ).toBe("A");
  });

  it("As a dotli user, a render error settles the open dialog and lets the overlays recover for what comes next", async () => {
    // Given: a one-time render error that is not tied to any single
    // dialog's own data. (A throw scoped to one dialog's view, e.g. a
    // `fields` getter, would not tell this test apart from the pre-fix
    // behaviour: Solid's own <Show keyed> in ModalOutlet already disposes
    // and retries that per-dialog subtree as soon as a *different* dialog is
    // queued next, so it self-heals either way. A throw here, in
    // ToastStack's own top-level store read, is not nested under anything
    // Solid recreates on its own, so — without this task's fix — it stays
    // broken forever: nothing ever disposes and remounts the root.)
    const getSpy = vi.spyOn(toastsStore, "get").mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const broken = presentModal(VIEW);

    try {
      // When
      await overlaysReady();

      // Then
      await expect(broken).resolves.toEqual({ result: "dismissed" });
      expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
        root: "overlays",
      });

      // When: a dialog queued after the error still renders and settles
      // from its own button, instead of hanging forever.
      const recovered = presentModal(VIEW);
      await overlaysReady();
      document
        .querySelector<HTMLButtonElement>("#overlay-root .signing-btn-sign")
        ?.click();

      // Then
      await expect(recovered).resolves.toEqual({ result: "yes" });

      // When: a toast pushed after the recovery is shown too.
      presentToast({
        text: "After the error",
        label: "Recovered",
        icon: "<svg></svg>",
        dismissMs: 0,
      });
      await overlaysReady();

      // Then
      expect(
        document.querySelector("#overlay-root .notif-title")?.textContent,
      ).toBe("Recovered");
    } finally {
      getSpy.mockRestore();
    }
  });

  // Must stay last: it replaces the module registry (vi.resetModules() +
  // vi.doMock), so any test after it would mount a fresh
  // components/overlays/mount tree bound to re-imported store instances
  // instead of the ones this file imported statically at the top.
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
});
