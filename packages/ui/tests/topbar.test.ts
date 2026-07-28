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
    <button id="theme-toggle" aria-expanded="false"></button>
    <div id="theme-popover" role="menu">
      <button class="theme-popover-option" role="menuitemradio" aria-checked="false" data-theme-option="light" tabindex="-1"></button>
      <button class="theme-popover-option" role="menuitemradio" aria-checked="false" data-theme-option="dark" tabindex="-1"></button>
      <button class="theme-popover-option" role="menuitemradio" aria-checked="false" data-theme-option="system" tabindex="-1"></button>
    </div>
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

  it("As a dotli integrator, the host cancels the in-flight login when Escape closes the pairing modal", async () => {
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
    await flushMicrotasks();

    // Then
    const backdrop = document.getElementById("auth-modal-backdrop");
    expect(backdrop?.classList.contains("open")).toBe(true);
    expect(document.activeElement).toBe(backdrop);

    // When
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    // Then
    expect(backdrop?.classList.contains("open")).toBe(false);
    expect(cancels).toBe(1);
    expect(document.activeElement).toBe(document.getElementById("auth-button"));
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

describe("topbar popover keyboard access", () => {
  it("As a dotli integrator, the host closes the settings popover on Escape and restores trigger focus", async () => {
    // Given
    installTopbarDom();
    const { initTopBar } = await import("@dotli/ui/topbar");
    initTopBar();
    const modeButton = document.getElementById("mode-button");
    const modePopover = document.getElementById("mode-popover");

    // When
    modeButton?.click();

    // Then
    expect(modePopover?.classList.contains("open")).toBe(true);
    expect(modeButton?.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(modePopover);

    // When
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    // Then
    expect(modePopover?.classList.contains("open")).toBe(false);
    expect(modeButton?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(modeButton);
  });

  it("As a dotli integrator, the host wraps Tab focus inside the settings popover", async () => {
    // Given
    installTopbarDom();
    const { initTopBar } = await import("@dotli/ui/topbar");
    initTopBar();
    document.getElementById("mode-button")?.click();
    const modePopover = document.getElementById("mode-popover");
    const focusables = Array.from(
      modePopover?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled])",
      ) ?? [],
    );
    expect(focusables.length).toBeGreaterThan(1);
    focusables[focusables.length - 1].focus();

    // When
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));

    // Then
    expect(document.activeElement).toBe(focusables[0]);

    // When
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true }),
    );

    // Then
    expect(document.activeElement).toBe(focusables[focusables.length - 1]);

    // Close so the trap's document listener doesn't leak into other tests.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });

  it("As a dotli integrator, the host lets Escape close the permission dropdown before the popover", async () => {
    // Given
    installTopbarDom();
    const { initTopBar } = await import("@dotli/ui/topbar");
    const { registerPermissionAuthorizationProvider } =
      await import("@dotli/ui/permissions");
    registerPermissionAuthorizationProvider("localhost:3000", {
      getPermissionAuthorizationStatuses: vi.fn(async (requests: unknown[]) =>
        requests.map(() => "NotDetermined" as const),
      ),
      setPermissionAuthorizationStatus: vi.fn(async () => {}),
    });
    initTopBar();
    window.dispatchEvent(
      new CustomEvent("dotli:product-loaded", {
        detail: { label: "localhost:3000" },
      }),
    );
    const permissionsButton = document.getElementById("permissions-button");
    const permissionsPopover = document.getElementById("permissions-popover");
    permissionsButton?.click();
    await flushMicrotasks();
    document
      .querySelector<HTMLButtonElement>(".permissions-popover-select")
      ?.click();
    expect(document.querySelector(".permissions-popover-menu")).not.toBeNull();

    // When
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    // Then
    expect(document.querySelector(".permissions-popover-menu")).toBeNull();
    expect(permissionsPopover?.classList.contains("open")).toBe(true);

    // When
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    // Then
    expect(permissionsPopover?.classList.contains("open")).toBe(false);
    expect(permissionsButton?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(permissionsButton);
  });

  it("As a dotli integrator, the host names each permission select for screen readers", async () => {
    // Given
    installTopbarDom();
    const { initTopBar } = await import("@dotli/ui/topbar");
    const { registerPermissionAuthorizationProvider } =
      await import("@dotli/ui/permissions");
    registerPermissionAuthorizationProvider("localhost:3000", {
      getPermissionAuthorizationStatuses: vi.fn(async (requests: unknown[]) =>
        requests.map(() => "NotDetermined" as const),
      ),
      setPermissionAuthorizationStatus: vi.fn(async () => {}),
    });
    initTopBar();
    window.dispatchEvent(
      new CustomEvent("dotli:product-loaded", {
        detail: { label: "localhost:3000" },
      }),
    );
    document.getElementById("permissions-button")?.click();
    await flushMicrotasks();

    // Then
    const select = document.querySelector<HTMLButtonElement>(
      ".permissions-popover-select",
    );
    const labelIds = select?.getAttribute("aria-labelledby")?.split(" ") ?? [];
    const labelText = labelIds
      .map((id) => document.getElementById(id)?.textContent)
      .join(" ");
    expect(labelText).toBe("Notifications Ask (Default)");

    // When
    select?.click();

    // Then
    const menu = document.querySelector<HTMLElement>(
      ".permissions-popover-menu",
    );
    expect(menu?.getAttribute("aria-label")).toBe("Notifications permission");
    const selected = menu?.querySelector<HTMLButtonElement>(
      '[aria-selected="true"]',
    );
    expect(document.activeElement).toBe(selected);

    // When
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );

    // Then
    expect(document.activeElement?.textContent).toBe("Allowed");

    // When
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    // Then
    expect(document.activeElement).toBe(select);

    // Cleanup
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });

  it("As a dotli integrator, the host keeps focus on the row select after changing a permission", async () => {
    // Given
    installTopbarDom();
    const { initTopBar } = await import("@dotli/ui/topbar");
    const { registerPermissionAuthorizationProvider } =
      await import("@dotli/ui/permissions");
    const setPermissionAuthorizationStatus = vi.fn(async () => {});
    registerPermissionAuthorizationProvider("localhost:3000", {
      getPermissionAuthorizationStatuses: vi.fn(async (requests: unknown[]) =>
        requests.map(() => "NotDetermined" as const),
      ),
      setPermissionAuthorizationStatus,
    });
    initTopBar();
    window.dispatchEvent(
      new CustomEvent("dotli:product-loaded", {
        detail: { label: "localhost:3000" },
      }),
    );
    document.getElementById("permissions-button")?.click();
    await flushMicrotasks();

    // When
    const selectId = "permissions-popover-select-Camera";
    document.getElementById(selectId)?.click();
    const allow = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        ".permissions-popover-menu-item",
      ),
    ).find((item) => item.textContent === "Allowed");
    allow?.click();
    await vi.waitFor(() => {
      expect(setPermissionAuthorizationStatus).toHaveBeenCalledTimes(1);
    });

    // Then
    await vi.waitFor(() => {
      expect(document.activeElement?.id).toBe(selectId);
    });

    // Cleanup
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });

  it("As a dotli integrator, the host keeps focus on the checked backend radio across re-renders", async () => {
    // Given
    installTopbarDom();
    const { initTopBar } = await import("@dotli/ui/topbar");
    initTopBar();
    document.getElementById("mode-button")?.click();
    const group = document.querySelector<HTMLElement>(
      '[role="radiogroup"][aria-label="Backend"]',
    );
    expect(group).not.toBeNull();
    const toggle = document.querySelector('[role="switch"]');
    expect(toggle?.getAttribute("aria-label")).toBe("dotNS cache");

    // When
    const next = Array.from(
      group?.querySelectorAll<HTMLInputElement>("input") ?? [],
    ).find((radio) => !radio.checked && !radio.disabled);
    next?.click();

    // Then
    const checked = group?.querySelector<HTMLInputElement>("input:checked");
    expect(checked?.value).toBe(next?.value);
    expect(document.activeElement).toBe(checked);

    // Cleanup
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
});

// Deterministic stand-in for the OS colour scheme, since happy-dom
// cannot evaluate prefers-color-scheme queries.
function stubColorScheme(initial: "light" | "dark"): {
  set: (scheme: "light" | "dark") => void;
} {
  let scheme = initial;
  const listeners = new Set<(e: Event) => void>();
  const mql = {
    get matches() {
      return scheme === "light";
    },
    media: "(prefers-color-scheme: light)",
    addEventListener: (_type: string, cb: (e: Event) => void) => {
      listeners.add(cb);
    },
    removeEventListener: (_type: string, cb: (e: Event) => void) => {
      listeners.delete(cb);
    },
  };
  vi.stubGlobal("matchMedia", () => mql);
  return {
    set: (next) => {
      scheme = next;
      for (const cb of listeners) {
        cb(new Event("change"));
      }
    },
  };
}

describe("topbar theme toggle", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-theme-pref");
  });

  function themeOption(pref: string): HTMLButtonElement | null {
    return document.querySelector<HTMLButtonElement>(
      `.theme-popover-option[data-theme-option="${pref}"]`,
    );
  }

  // Boot the topbar with a known preference and OS scheme, then open the menu.
  async function openThemeMenu(
    stored: "light" | "dark" | "system",
    os: "light" | "dark",
  ): Promise<HTMLElement | null> {
    installTopbarDom();
    stubColorScheme(os);
    localStorage.setItem("dotli-theme", stored);
    const { initTopBar } = await import("@dotli/ui/topbar");
    initTopBar();
    const btn = document.getElementById("theme-toggle");
    btn?.click();
    return btn;
  }

  function pressThemeKey(key: string): void {
    document
      .getElementById("theme-popover")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  }

  it("As a dotli user, the theme button opens a menu with the current theme checked", async () => {
    // Given
    installTopbarDom();
    stubColorScheme("dark");
    localStorage.setItem("dotli-theme", "light");
    const { initTopBar } = await import("@dotli/ui/topbar");
    initTopBar();
    const btn = document.getElementById("theme-toggle");
    const popover = document.getElementById("theme-popover");

    // When
    btn?.click();

    // Then
    expect(popover?.classList.contains("open")).toBe(true);
    expect(btn?.getAttribute("aria-expanded")).toBe("true");
    expect(themeOption("light")?.getAttribute("aria-checked")).toBe("true");
    expect(themeOption("dark")?.getAttribute("aria-checked")).toBe("false");
    expect(themeOption("system")?.getAttribute("aria-checked")).toBe("false");
    expect(document.activeElement).toBe(themeOption("light"));
  });

  it("As a dotli user, I select Dark from the theme menu and it applies and persists", async () => {
    // Given
    const btn = await openThemeMenu("light", "light");
    const popover = document.getElementById("theme-popover");

    // When
    themeOption("dark")?.click();

    // Then
    expect(localStorage.getItem("dotli-theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme-pref")).toBe(
      "dark",
    );
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(themeOption("dark")?.getAttribute("aria-checked")).toBe("true");
    expect(popover?.classList.contains("open")).toBe(false);
    expect(btn?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(btn);
  });

  it("As a dotli user, I select System from the theme menu and the theme resolves from the OS", async () => {
    // Given
    await openThemeMenu("dark", "light");

    // When
    themeOption("system")?.click();

    // Then
    expect(localStorage.getItem("dotli-theme")).toBe("system");
    expect(document.documentElement.getAttribute("data-theme-pref")).toBe(
      "system",
    );
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("As a keyboard user, I press ArrowDown in the theme menu and focus moves to the next option", async () => {
    // Given
    await openThemeMenu("light", "dark");

    // When
    pressThemeKey("ArrowDown");

    // Then
    expect(document.activeElement).toBe(themeOption("dark"));
  });

  it("As a keyboard user, I press ArrowUp on the first theme option and focus wraps to the last", async () => {
    // Given
    await openThemeMenu("light", "dark");

    // When
    pressThemeKey("ArrowUp");

    // Then
    expect(document.activeElement).toBe(themeOption("system"));
  });

  it("As a keyboard user, I press Home in the theme menu and focus moves to the first option", async () => {
    // Given
    await openThemeMenu("system", "dark");

    // When
    pressThemeKey("Home");

    // Then
    expect(document.activeElement).toBe(themeOption("light"));
  });

  it("As a keyboard user, I press End in the theme menu and focus moves to the last option", async () => {
    // Given
    await openThemeMenu("light", "dark");

    // When
    pressThemeKey("End");

    // Then
    expect(document.activeElement).toBe(themeOption("system"));
  });

  it("As a keyboard user, I press Escape in the theme menu and it closes without changing the theme", async () => {
    // Given
    const btn = await openThemeMenu("light", "dark");
    const popover = document.getElementById("theme-popover");

    // When
    pressThemeKey("Escape");

    // Then
    expect(popover?.classList.contains("open")).toBe(false);
    expect(btn?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(btn);
    expect(localStorage.getItem("dotli-theme")).toBe("light");
  });

  it("As a keyboard user, I press Tab in the theme menu and it closes so focus leaves the menu", async () => {
    // Given
    const btn = await openThemeMenu("light", "dark");
    const popover = document.getElementById("theme-popover");

    // When
    pressThemeKey("Tab");

    // Then
    expect(popover?.classList.contains("open")).toBe(false);
    expect(btn?.getAttribute("aria-expanded")).toBe("false");
  });

  it("As a dotli user, clicking outside closes the theme menu", async () => {
    // Given
    const btn = await openThemeMenu("dark", "dark");
    const popover = document.getElementById("theme-popover");

    // When
    document.body.click();

    // Then
    expect(popover?.classList.contains("open")).toBe(false);
    expect(btn?.getAttribute("aria-expanded")).toBe("false");
  });

  it("As a dotli user, the System option follows OS theme changes", async () => {
    // Given
    installTopbarDom();
    const os = stubColorScheme("dark");
    localStorage.setItem("dotli-theme", "system");
    const { initTopBar } = await import("@dotli/ui/topbar");
    let changes = 0;
    const onThemeChanged = (): void => {
      changes += 1;
    };
    window.addEventListener("dotli:theme-changed", onThemeChanged);
    initTopBar();
    const changesAfterInit = changes;

    // When
    os.set("light");
    window.removeEventListener("dotli:theme-changed", onThemeChanged);

    // Then
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(changes).toBe(changesAfterInit + 1);
  });

  it("As a dotli user, an explicit theme ignores OS theme changes", async () => {
    // Given
    installTopbarDom();
    const os = stubColorScheme("light");
    localStorage.setItem("dotli-theme", "dark");
    const { initTopBar } = await import("@dotli/ui/topbar");
    initTopBar();

    // When
    os.set("dark");
    os.set("light");

    // Then
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme-pref")).toBe(
      "dark",
    );
  });

  it("As a dotli user, a fresh profile defaults to the System option", async () => {
    // Given
    installTopbarDom();
    stubColorScheme("light");
    const { initTopBar } = await import("@dotli/ui/topbar");

    // When
    initTopBar();

    // Then
    expect(localStorage.getItem("dotli-theme")).toBeNull();
    expect(document.documentElement.getAttribute("data-theme-pref")).toBe(
      "system",
    );
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
