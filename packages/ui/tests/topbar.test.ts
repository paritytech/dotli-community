import { beforeEach, describe, expect, it, vi } from "vitest";

const sharedAuth = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  listeners: new Set<
    (change: { siteId: string; key: string; value: string | null }) => void
  >(),
}));

vi.mock("@dotli/protocol/client", () => ({
  readSharedAuthStorage: async (siteId: string, key: string) => {
    return sharedAuth.storage.get(`${siteId}:${key}`) ?? null;
  },
  writeSharedAuthStorage: async (
    siteId: string,
    key: string,
    value: string,
  ) => {
    sharedAuth.storage.set(`${siteId}:${key}`, value);
  },
  clearSharedAuthStorage: async (siteId: string, key: string) => {
    sharedAuth.storage.delete(`${siteId}:${key}`);
  },
  subscribeSharedAuthStorage: (
    listener: (change: {
      siteId: string;
      key: string;
      value: string | null;
    }) => void,
  ) => {
    sharedAuth.listeners.add(listener);
    return () => {
      sharedAuth.listeners.delete(listener);
    };
  },
}));

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function installTopbarDom(): void {
  document.body.innerHTML = `
    <a id="topbar-home"></a>
    <button id="auth-button" disabled></button>
    <div id="auth-modal-backdrop">
      <div id="auth-modal-title"></div>
      <div id="auth-modal-qr"></div>
      <div id="auth-modal-reason"></div>
      <div id="auth-modal-hint"></div>
      <button id="auth-modal-close"></button>
    </div>
    <div id="user-popover">
      <span id="user-popover-username"></span>
      <button id="user-popover-disconnect"></button>
    </div>
    <button id="theme-toggle"></button>
    <span id="theme-icon-sun"></span>
    <span id="theme-icon-moon"></span>
    <button id="mode-button"></button>
    <div id="mode-popover"><div id="mode-popover-content"></div></div>
    <div id="mode-popover-backdrop"></div>
    <button id="permissions-button"></button>
    <div id="permissions-popover"><div id="permissions-popover-list"></div></div>
    <div id="permissions-popover-backdrop"></div>
  `;
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  sharedAuth.storage.clear();
  sharedAuth.listeners.clear();
  document.body.innerHTML = "";
});

describe("topbar disconnect", () => {
  it("As a dotli integrator, the host emits the Rust-core disconnect request", async () => {
    // Given
    const { requestTruapiDisconnect } = await import("@dotli/ui/topbar");
    let requests = 0;
    window.addEventListener(
      "dotli:truapi-disconnect-request",
      () => {
        requests += 1;
      },
      { once: true },
    );

    // When
    requestTruapiDisconnect();

    // Then
    expect(requests).toBe(1);
  }, 10_000);

  it("As a dotli integrator, the host routes the disconnect button through the Rust-core event path", async () => {
    // Given
    installTopbarDom();
    const { initTopBar } = await import("@dotli/ui/topbar");
    let requests = 0;
    window.addEventListener("dotli:truapi-disconnect-request", () => {
      requests += 1;
    });

    initTopBar();
    window.dispatchEvent(
      new CustomEvent("dotli:truapi-auth-state", {
        detail: { tag: "Connected", session: { connected: true } },
      }),
    );

    // When
    document.getElementById("auth-button")?.click();

    // Then
    expect(
      document.getElementById("user-popover")?.classList.contains("open"),
    ).toBe(true);

    // When
    document.getElementById("user-popover-disconnect")?.click();

    // Then
    expect(requests).toBe(1);
    expect(
      document.getElementById("user-popover")?.classList.contains("open"),
    ).toBe(false);
  });

  it("As a dotli integrator, the host renders the connected username from the Rust-core auth state", async () => {
    // Given
    installTopbarDom();
    const { initTopBar } = await import("@dotli/ui/topbar");
    initTopBar();

    // When
    window.dispatchEvent(
      new CustomEvent("dotli:truapi-auth-state", {
        detail: {
          tag: "Connected",
          session: {
            connected: true,
            publicKey:
              "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
            liteUsername: "pgherveou.04",
            primaryUsername: "pgherveou.04",
          },
        },
      }),
    );

    // Then
    expect(document.getElementById("auth-button")?.textContent).toBe("PG");
    expect(document.getElementById("user-popover-username")?.textContent).toBe(
      "pgherveou.04",
    );
  });
});

describe("topbar login cancellation", () => {
  it("As a dotli integrator, the host waits for an active TrUAPI prompt before opening login", async () => {
    // Given
    installTopbarDom();
    const [{ initTopBar }, { createBlockingModalCoordinator }] =
      await Promise.all([
        import("@dotli/ui/topbar"),
        import("@dotli/ui/blocking-modal-queue"),
      ]);
    const coordinator = createBlockingModalCoordinator();
    initTopBar(coordinator);
    const scope = coordinator.createScope();
    let releaseBlockingPrompt: (() => void) | null = null;
    const blockingPrompt = scope.enqueue(
      () =>
        new Promise<void>((resolve) => {
          releaseBlockingPrompt = resolve;
        }),
    );

    // When
    document.getElementById("auth-button")?.click();

    // Then
    expect(
      document
        .getElementById("auth-modal-backdrop")
        ?.classList.contains("open"),
    ).toBe(false);

    // When
    releaseBlockingPrompt?.();
    await blockingPrompt;

    // Then
    expect(
      document
        .getElementById("auth-modal-backdrop")
        ?.classList.contains("open"),
    ).toBe(true);

    document.getElementById("auth-modal-close")?.click();
    scope.dispose();
  });

  it("As a dotli integrator, the host opens host-global login from the topbar even when a product is loaded", async () => {
    // Given
    installTopbarDom();
    const { initTopBar } = await import("@dotli/ui/topbar");
    const loginRequests: unknown[] = [];
    window.addEventListener("dotli:truapi-login-request", (event) => {
      loginRequests.push((event as CustomEvent).detail);
    });
    initTopBar();

    // When
    window.dispatchEvent(
      new CustomEvent("dotli:product-loaded", {
        detail: { label: "localhost:3000" },
      }),
    );
    document.getElementById("auth-button")?.click();

    // Then
    expect(document.getElementById("auth-modal-title")?.textContent).toBe(
      "Login with Polkadot Mobile",
    );
    expect(loginRequests).toEqual([{ reason: undefined }]);
  });

  it("As a dotli integrator, the host emits a login request on the first auth button click", async () => {
    // Given
    installTopbarDom();
    const { initTopBar } = await import("@dotli/ui/topbar");
    const loginRequests: unknown[] = [];
    window.addEventListener("dotli:truapi-login-request", (event) => {
      loginRequests.push((event as CustomEvent).detail);
    });
    initTopBar();

    (
      window as typeof window & { __dotliTruapiBridgeReady?: boolean }
    ).__dotliTruapiBridgeReady = true;

    // Then
    expect(
      document.getElementById("auth-button")?.hasAttribute("disabled"),
    ).toBe(false);

    // When
    document.getElementById("auth-button")?.click();

    // Then
    expect(loginRequests).toEqual([{ reason: undefined }]);
    expect(
      document
        .getElementById("auth-modal-backdrop")
        ?.classList.contains("open"),
    ).toBe(true);
  });

  it("As a dotli integrator, the host keeps the pairing modal open through an unrelated disconnected state", async () => {
    // Given
    installTopbarDom();
    const { initTopBar } = await import("@dotli/ui/topbar");
    initTopBar();

    // When
    window.dispatchEvent(
      new CustomEvent("dotli:truapi-auth-state", {
        detail: {
          tag: "Pairing",
          deeplink: "polkadotapp://pair?handshake=test",
          label: "Polkadot Web",
          dotSuffix: false,
          hostGlobal: true,
        },
      }),
    );
    // A bare disconnected state (e.g. a product core clearing its session)
    // must only update the badge, never tear down the pairing modal.
    window.dispatchEvent(
      new CustomEvent("dotli:truapi-auth-state", {
        detail: { tag: "Disconnected" },
      }),
    );

    // Then
    expect(
      document
        .getElementById("auth-modal-backdrop")
        ?.classList.contains("open"),
    ).toBe(true);
  });

  it("As a dotli integrator, the host keeps landing pairing presentation host-global", async () => {
    // Given
    installTopbarDom();
    const { initTopBar } = await import("@dotli/ui/topbar");
    initTopBar();

    // When
    window.dispatchEvent(
      new CustomEvent("dotli:truapi-auth-state", {
        detail: {
          tag: "Pairing",
          deeplink: "polkadotapp://pair?handshake=test",
          label: "Polkadot Web",
          dotSuffix: false,
          hostGlobal: true,
        },
      }),
    );

    // Then
    expect(document.getElementById("auth-modal-title")?.textContent).toBe(
      "Login with Polkadot Mobile",
    );
  });

  it("As a dotli integrator, the host cancels the in-flight login when the user closes the pairing modal", async () => {
    // Given
    installTopbarDom();
    const { initTopBar } = await import("@dotli/ui/topbar");
    initTopBar();
    let cancels = 0;
    window.addEventListener("dotli:truapi-cancel-login", () => {
      cancels += 1;
    });

    // When
    window.dispatchEvent(
      new CustomEvent("dotli:truapi-auth-state", {
        detail: {
          tag: "Pairing",
          deeplink: "polkadotapp://pair?handshake=test",
          label: "localhost:3000",
        },
      }),
    );
    document.getElementById("auth-modal-close")?.click();

    // Then
    expect(cancels).toBe(1);
    expect(
      document
        .getElementById("auth-modal-backdrop")
        ?.classList.contains("open"),
    ).toBe(false);
    expect(document.getElementById("auth-modal-qr")?.children).toHaveLength(0);
  });

  it("As a dotli integrator, the host closes the pairing modal when the session connects", async () => {
    // Given
    installTopbarDom();
    const { initTopBar } = await import("@dotli/ui/topbar");
    initTopBar();
    let cancels = 0;
    window.addEventListener("dotli:truapi-cancel-login", () => {
      cancels += 1;
    });

    // When
    window.dispatchEvent(
      new CustomEvent("dotli:truapi-auth-state", {
        detail: {
          tag: "Pairing",
          deeplink: "polkadotapp://pair?handshake=test",
          label: "localhost:3000",
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent("dotli:truapi-auth-state", {
        detail: {
          tag: "Connected",
          session: { connected: true, liteUsername: "pgherveou.04" },
        },
      }),
    );

    // Then
    expect(
      document
        .getElementById("auth-modal-backdrop")
        ?.classList.contains("open"),
    ).toBe(false);
    expect(cancels).toBe(0);
    expect(document.getElementById("auth-button")?.textContent).toBe("PG");
  });

  it("As a dotli integrator, the host replaces the pairing QR with login progress after wallet approval", async () => {
    // Given
    installTopbarDom();
    const { initTopBar } = await import("@dotli/ui/topbar");
    initTopBar();

    // When
    window.dispatchEvent(
      new CustomEvent("dotli:truapi-auth-state", {
        detail: {
          tag: "Pairing",
          deeplink: "polkadotapp://pair?handshake=test",
          label: "Polkadot Web",
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent("dotli:truapi-auth-state", {
        detail: { tag: "Authenticating" },
      }),
    );

    // Then
    expect(document.getElementById("auth-modal-qr")?.textContent).toContain(
      "Logging in...",
    );
    expect(document.querySelector("#auth-modal-qr .spinner")).not.toBeNull();
    expect(
      document
        .getElementById("auth-modal-backdrop")
        ?.classList.contains("open"),
    ).toBe(true);
  });

  it("As a dotli integrator, the host keeps the retry view for login failures", async () => {
    // Given
    installTopbarDom();
    const { initTopBar } = await import("@dotli/ui/topbar");
    initTopBar();

    // When
    window.dispatchEvent(
      new CustomEvent("dotli:product-loaded", {
        detail: { label: "localhost:3000" },
      }),
    );
    window.dispatchEvent(
      new CustomEvent("dotli:truapi-auth-state", {
        detail: { tag: "LoginFailed", reason: "Host failure" },
      }),
    );

    // Then
    expect(document.getElementById("auth-modal-title")?.textContent).toBe(
      "Login with Polkadot Mobile",
    );
    expect(
      document
        .getElementById("auth-modal-backdrop")
        ?.classList.contains("open"),
    ).toBe(true);
    expect(document.getElementById("auth-modal-qr")?.textContent).toContain(
      "Retry",
    );
  });

  it("explains statement-store slot exhaustion in the login failure view", async () => {
    installTopbarDom();
    const { initTopBar } = await import("@dotli/ui/topbar");
    initTopBar();

    window.dispatchEvent(
      new CustomEvent("dotli:truapi-auth-state", {
        detail: {
          tag: "LoginFailed",
          reason: "no free statement-store slot for device registration",
        },
      }),
    );

    const modalText = document.getElementById("auth-modal-qr")?.textContent;
    expect(modalText).toContain("No Statement Store slots left");
    expect(modalText).toContain(
      "no free statement-store slot for device registration",
    );
    expect(modalText).toContain("Retry");
  });

  it("explains rejected statement-store transactions from the raw reason", async () => {
    installTopbarDom();
    const { initTopBar } = await import("@dotli/ui/topbar");
    initTopBar();

    window.dispatchEvent(
      new CustomEvent("dotli:truapi-auth-state", {
        detail: {
          tag: "LoginFailed",
          reason: "submit RPC error: Invalid Transaction",
        },
      }),
    );

    const modalText = document.getElementById("auth-modal-qr")?.textContent;
    expect(modalText).toContain("Statement Store transaction rejected");
    expect(modalText).toContain("submit RPC error: Invalid Transaction");
    expect(modalText).toContain("Retry");
  });
});

describe("topbar boot rehydration", () => {
  it("As a dotli integrator, the host renders the persisted session badge on idle after init", async () => {
    // Given
    installTopbarDom();
    vi.stubGlobal("requestIdleCallback", (callback: () => void): number => {
      callback();
      return 0;
    });

    const { SHARED_CORE_SESSION_KEY } =
      await import("@dotli/protocol/auth-storage");
    const { SITE_ID } = await import("@dotli/config/config");
    // Opaque session blob plus the JSON UI-state cache the core-driven
    // authStateChanged callback persists alongside it in shared auth storage.
    sharedAuth.storage.set(`${SITE_ID}:${SHARED_CORE_SESSION_KEY}`, "0x0102");
    sharedAuth.storage.set(
      `${SITE_ID}:${SHARED_CORE_SESSION_KEY}:ui-state`,
      JSON.stringify({
        connected: true,
        publicKey:
          "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
        liteUsername: "pgherveou.04",
        primaryUsername: "pgherveou.04",
      }),
    );

    // When
    const { initTopBar } = await import("@dotli/ui/topbar");
    initTopBar();
    await flushMicrotasks();

    // Then
    expect(document.getElementById("auth-button")?.textContent).toBe("PG");
    expect(document.getElementById("user-popover-username")?.textContent).toBe(
      "pgherveou.04",
    );
  });

  it("As a dotli integrator, the host stays logged out when no session is persisted", async () => {
    // Given
    installTopbarDom();
    vi.stubGlobal("requestIdleCallback", (callback: () => void): number => {
      callback();
      return 0;
    });

    // When
    const { initTopBar } = await import("@dotli/ui/topbar");
    initTopBar();

    // Then
    expect(
      document.getElementById("auth-button")?.querySelector(".user-badge"),
    ).toBeNull();
  });
});

describe("topbar permissions", () => {
  it("As a dotli integrator, the host renders one row per permission after changing a dropdown", async () => {
    // Given
    installTopbarDom();
    const { initTopBar } = await import("@dotli/ui/topbar");
    const { ALL_PERMISSIONS, registerPermissionAuthorizationProvider } =
      await import("@dotli/ui/permissions");
    const setPermissionAuthorizationStatus = vi.fn(async () => {});
    registerPermissionAuthorizationProvider("localhost:3000", {
      getPermissionAuthorizationStatuses: vi.fn(async (requests: unknown[]) =>
        requests.map(() => "NotDetermined" as const),
      ),
      setPermissionAuthorizationStatus,
    });
    initTopBar();

    // When
    window.dispatchEvent(
      new CustomEvent("dotli:product-loaded", {
        detail: { label: "localhost:3000" },
      }),
    );
    document.getElementById("permissions-button")?.click();
    await flushMicrotasks();

    // When
    document
      .querySelector<HTMLButtonElement>(".permissions-popover-select")
      ?.click();
    const allow = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        ".permissions-popover-menu-item",
      ),
    ).find((item) => item.textContent === "Allowed");
    allow?.click();
    await vi.waitFor(() => {
      expect(setPermissionAuthorizationStatus).toHaveBeenCalledTimes(1);
    });
    await flushMicrotasks();

    // Then
    expect(document.querySelectorAll(".permissions-popover-row")).toHaveLength(
      ALL_PERMISSIONS.length,
    );
  });
});
