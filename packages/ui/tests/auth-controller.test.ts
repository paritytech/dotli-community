// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BlockingModalCoordinator,
  BlockingModalScope,
} from "@dotli/ui/blocking-modal-queue";

type Modules = typeof import("@dotli/ui/auth-controller") &
  typeof import("@dotli/ui/state/auth-modal") &
  typeof import("@dotli/ui/state/auth") &
  typeof import("@dotli/ui/blocking-modal-queue");

// Window listeners the controller under test added; removed after each test
// so an earlier test's controller never reacts to a later test's events.
let controllerListeners: Parameters<typeof window.removeEventListener>[] = [];

// A fresh module graph per test: the controller keeps its lease and session
// flags at module scope, and the stores start from their defaults.
async function load(
  coordinator?: BlockingModalCoordinator,
): Promise<Modules & { coordinator: BlockingModalCoordinator }> {
  const [controller, modal, auth, queue] = await Promise.all([
    import("@dotli/ui/auth-controller"),
    import("@dotli/ui/state/auth-modal"),
    import("@dotli/ui/state/auth"),
    import("@dotli/ui/blocking-modal-queue"),
  ]);
  const used = coordinator ?? queue.createBlockingModalCoordinator();
  const spy = vi.spyOn(window, "addEventListener");
  controller.initAuthController(used);
  controllerListeners = spy.mock.calls.map(([type, listener]) => [
    type,
    listener,
  ]);
  spy.mockRestore();
  return { ...controller, ...modal, ...auth, ...queue, coordinator: used };
}

function countEvents(name: string): { count: number; details: unknown[] } {
  const seen = { count: 0, details: [] as unknown[] };
  window.addEventListener(name, (event) => {
    seen.count += 1;
    seen.details.push((event as CustomEvent).detail);
  });
  return seen;
}

/**
 * Holds each enqueued task until the test runs it, to force races. Dispose
 * is only recorded, never aborts: the task sees a live signal, as when a
 * queue starts a task before it processes that scope's disposal.
 */
function manualCoordinator(): {
  coordinator: BlockingModalCoordinator;
  tasks: { run: () => Promise<void>; disposed: () => boolean }[];
} {
  const tasks: { run: () => Promise<void>; disposed: () => boolean }[] = [];
  const coordinator: BlockingModalCoordinator = {
    createScope(): BlockingModalScope {
      const signal = new AbortController().signal;
      let disposed = false;
      return {
        enqueue<T>(task: (signal: AbortSignal) => Promise<T> | T): Promise<T> {
          return new Promise<T>((resolve) => {
            tasks.push({
              run: async () => {
                resolve(await task(signal));
              },
              disposed: () => disposed,
            });
          });
        },
        dispose(): void {
          disposed = true;
        },
      };
    },
  };
  return { coordinator, tasks };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  for (const [type, listener] of controllerListeners) {
    window.removeEventListener(type, listener);
  }
  controllerListeners = [];
});

describe("auth controller: login requests", () => {
  it("As a product, a dotli:request-login sent before any modal subscriber exists is reflected in the store", async () => {
    // Given
    const { getAuthModalState } = await load();
    const requests = countEvents("dotli:truapi-login-request");

    // When
    window.dispatchEvent(
      new CustomEvent("dotli:request-login", {
        detail: { reason: "Sign the transfer", label: "localhost:3000" },
      }),
    );

    // Then
    expect(getAuthModalState()).toEqual({
      open: true,
      productLabel: "localhost:3000",
      reason: "Sign the transfer",
      view: { kind: "spinner" },
    });
    expect(requests.details).toEqual([{ reason: "Sign the transfer" }]);
  });

  it("As a product, a deployed label gets the active network's TLD in the modal title", async () => {
    // Given
    const { getAuthModalState } = await load();
    const { withActiveTld } = await import("@dotli/config/network");

    // When
    window.dispatchEvent(
      new CustomEvent("dotli:request-login", { detail: { label: "foo" } }),
    );

    // Then
    expect(getAuthModalState().productLabel).toBe(withActiveTld("foo"));
    expect(getAuthModalState().reason).toBeNull();
  });

  it("As the error view, retryLogin re-opens the spinner and asks the core to log in again", async () => {
    // Given
    const { getAuthModalState, retryLogin, setAuthState } = await load();
    setAuthState({ tag: "LoginFailed", kind: "Other", reason: "Host failure" });
    const requests = countEvents("dotli:truapi-login-request");

    // When
    retryLogin();

    // Then
    expect(getAuthModalState().view).toEqual({ kind: "spinner" });
    expect(getAuthModalState().open).toBe(true);
    expect(requests.details).toEqual([{ reason: undefined }]);
  });

  it("As the user popover, requestTruapiDisconnect emits the Rust-core disconnect request", async () => {
    // Given
    const { requestTruapiDisconnect } = await load();
    const requests = countEvents("dotli:truapi-disconnect-request");

    // When
    requestTruapiDisconnect();

    // Then
    expect(requests.count).toBe(1);
  });
});

describe("auth controller: blocking-modal lease", () => {
  it("As the auth modal, I wait for an active blocking prompt before opening", async () => {
    // Given
    const { coordinator, getAuthModalState, openAuthModal, closeAuthModal } =
      await load();
    const scope = coordinator.createScope();
    let releasePrompt: (() => void) | null = null;
    const prompt = scope.enqueue(
      () =>
        new Promise<void>((resolve) => {
          releasePrompt = resolve;
        }),
    );

    // When
    openAuthModal();

    // Then
    expect(getAuthModalState().open).toBe(false);

    // When
    releasePrompt?.();
    await prompt;

    // Then
    expect(getAuthModalState().open).toBe(true);
    closeAuthModal();
    scope.dispose();
  });

  it("As the auth modal, of two overlapping requests only the newest scope holds the lease", async () => {
    // Given
    const { coordinator, tasks } = manualCoordinator();
    const { getAuthModalState, openAuthModal, closeAuthModal } =
      await load(coordinator);
    openAuthModal();
    closeAuthModal({ skipTruapiCancel: true });
    openAuthModal();
    expect(tasks).toHaveLength(2);
    const [stale, current] = tasks;

    expect(stale.disposed()).toBe(true);

    // When: the replaced scope's task starts with a live signal
    await stale.run();

    // Then: it resolves at once and never opens the modal
    expect(getAuthModalState().open).toBe(false);

    // When
    const running = current.run();

    // Then
    expect(getAuthModalState().open).toBe(true);

    // When: closing releases the newest scope's lease
    closeAuthModal({ skipTruapiCancel: true });
    await running;

    // Then
    expect(getAuthModalState().open).toBe(false);
  });

  it("As the auth modal, a second open while a lease is pending reuses it", async () => {
    // Given
    const { coordinator, tasks } = manualCoordinator();
    const { openAuthModal } = await load(coordinator);

    // When
    openAuthModal();
    openAuthModal("again");

    // Then
    expect(tasks).toHaveLength(1);
  });

  it("As the user, closing the modal releases the lease and cancels the in-flight login once", async () => {
    // Given
    const { coordinator, getAuthModalState, openAuthModal, closeAuthModal } =
      await load();
    const cancels = countEvents("dotli:truapi-cancel-login");
    openAuthModal("why", "localhost:3000");
    expect(getAuthModalState().open).toBe(true);
    const next = coordinator.createScope();
    let nextRan = false;

    // When
    const queued = next.enqueue(() => {
      nextRan = true;
    });
    closeAuthModal();
    await queued;

    // Then
    expect(cancels.count).toBe(1);
    expect(nextRan).toBe(true);
    expect(getAuthModalState()).toEqual({
      open: false,
      productLabel: null,
      reason: null,
      view: { kind: "spinner" },
    });
    next.dispose();
  });

  it("As the core, a Connected close does not cancel the login", async () => {
    // Given
    const { getAuthModalState, openAuthModal, closeAuthModal } = await load();
    const cancels = countEvents("dotli:truapi-cancel-login");
    openAuthModal();

    // When
    closeAuthModal({ skipTruapiCancel: true });

    // Then
    expect(cancels.count).toBe(0);
    expect(getAuthModalState().open).toBe(false);
  });

  it("As the host, opening without a coordinator is a wiring error", async () => {
    // Given
    const { openAuthModal } = await import("@dotli/ui/auth-controller");

    // When / Then
    expect(() => {
      openAuthModal();
    }).toThrow();
  });
});

describe("auth controller: auth states", () => {
  const pairing = {
    tag: "Pairing",
    deeplink: "polkadotapp://pair?handshake=test",
    label: "localhost:3000",
  } as const;

  it("As the core, Pairing opens the modal with the QR payload and the product label", async () => {
    // Given
    const { getAuthModalState, setAuthState } = await load();

    // When
    setAuthState(pairing);

    // Then
    expect(getAuthModalState()).toEqual({
      open: true,
      productLabel: "localhost:3000",
      reason: null,
      view: { kind: "pairing", payload: "polkadotapp://pair?handshake=test" },
    });
  });

  it("As the landing page, a host-global Pairing has no product label", async () => {
    // Given
    const { getAuthModalState, setAuthState } = await load();

    // When
    setAuthState({
      ...pairing,
      label: "Polkadot Web",
      dotSuffix: false,
      hostGlobal: true,
    });

    // Then
    expect(getAuthModalState().productLabel).toBeNull();
  });

  it("As the core, a Pairing without a deeplink yet shows the spinner", async () => {
    // Given
    const { getAuthModalState, setAuthState } = await load();

    // When
    setAuthState({ ...pairing, deeplink: "" });

    // Then
    expect(getAuthModalState().view).toEqual({ kind: "spinner" });
  });

  it("As the core, Authenticating replaces the QR with progress and keeps the modal open", async () => {
    // Given
    const { getAuthModalState, setAuthState } = await load();
    setAuthState(pairing);

    // When
    setAuthState({ tag: "Authenticating" });

    // Then
    expect(getAuthModalState().view).toEqual({ kind: "authenticating" });
    expect(getAuthModalState().open).toBe(true);
  });

  it("As the core, Connected closes the modal without cancelling and marks the session logged in", async () => {
    // Given
    const { getAuthModalState, getLoggedIn, setAuthState } = await load();
    const cancels = countEvents("dotli:truapi-cancel-login");
    setAuthState(pairing);

    // When
    setAuthState({ tag: "Connected", session: { connected: true } });

    // Then
    expect(getAuthModalState().open).toBe(false);
    expect(cancels.count).toBe(0);
    expect(getLoggedIn()).toBe(true);
  });

  it("As the core, Disconnected logs out but never tears down an active pairing", async () => {
    // Given
    const { getAuthModalState, getLoggedIn, setAuthState } = await load();
    setAuthState({ tag: "Connected", session: { connected: true } });
    setAuthState(pairing);

    // When
    setAuthState({ tag: "Disconnected" });

    // Then
    expect(getAuthModalState().open).toBe(true);
    expect(getAuthModalState().view.kind).toBe("pairing");
    expect(getLoggedIn()).toBe(false);
  });

  it("As a new user, LoginFailed opens the host-global modal with retryable error copy", async () => {
    // Given
    const { getAuthModalState, setAuthState } = await load();

    // When
    setAuthState({
      tag: "LoginFailed",
      kind: "Other",
      reason: "User declined the request",
    });

    // Then
    expect(getAuthModalState()).toEqual({
      open: true,
      productLabel: null,
      reason: null,
      view: {
        kind: "error",
        message: "User declined the request",
        retry: true,
        title: "Login was declined",
        subtitle:
          "The request was declined in Polkadot Mobile. Start again and approve it on your phone.",
        detail: "User declined the request",
      },
    });
  });

  it("As a new user, an exhausted allowance is not offered a retry", async () => {
    // Given
    const { getAuthModalState, setAuthState } = await load();

    // When
    setAuthState({
      tag: "LoginFailed",
      kind: "NoFreeAllowanceSlots",
      reason: "no slots",
    });

    // Then
    expect(getAuthModalState().view).toMatchObject({
      kind: "error",
      retry: false,
      title: "No Statement Store slots left",
      detail: "no slots",
    });
  });

  it("As a new user, an account still being set up hides the raw reason", async () => {
    // Given
    const { getAuthModalState, setAuthState } = await load();

    // When
    setAuthState({
      tag: "LoginFailed",
      kind: "Other",
      reason: "OriginPersonProviderError",
    });

    // Then
    expect(getAuthModalState().view).toMatchObject({
      kind: "error",
      message: "OriginPersonProviderError",
      retry: true,
      title: "Your account is still being set up",
      detail: undefined,
    });
  });

  it("As the host, init reports the logged-out state once", async () => {
    // Given
    const loggedOut = countEvents("dotli:logged-out");

    // When
    const { getLoggedIn } = await load();

    // Then
    expect(loggedOut.count).toBe(1);
    expect(getLoggedIn()).toBe(false);
  });
});
