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
  it("emits the Rust-core disconnect request", async () => {
    const { requestTruapiDisconnect } = await import("@dotli/ui/topbar");
    let requests = 0;
    window.addEventListener(
      "dotli:truapi-disconnect-request",
      () => {
        requests += 1;
      },
      { once: true },
    );

    requestTruapiDisconnect();

    expect(requests).toBe(1);
  });

  it("routes the disconnect button through the Rust-core event path", async () => {
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

    document.getElementById("auth-button")?.click();
    expect(
      document.getElementById("user-popover")?.classList.contains("open"),
    ).toBe(true);

    document.getElementById("user-popover-disconnect")?.click();

    expect(requests).toBe(1);
    expect(
      document.getElementById("user-popover")?.classList.contains("open"),
    ).toBe(false);
  });

  it("renders the connected username from the Rust-core auth state", async () => {
    installTopbarDom();
    const { initTopBar } = await import("@dotli/ui/topbar");
    initTopBar();

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

    expect(document.getElementById("auth-button")?.textContent).toBe("PG");
    expect(document.getElementById("user-popover-username")?.textContent).toBe(
      "pgherveou.04",
    );
  });
});

describe("topbar login cancellation", () => {
  it("opens host-global login from the topbar even when a product is loaded", async () => {
    installTopbarDom();
    const { initTopBar } = await import("@dotli/ui/topbar");
    const loginRequests: unknown[] = [];
    window.addEventListener("dotli:truapi-login-request", (event) => {
      loginRequests.push((event as CustomEvent).detail);
    });
    initTopBar();

    window.dispatchEvent(
      new CustomEvent("dotli:product-loaded", {
        detail: { label: "localhost:3000" },
      }),
    );
    document.getElementById("auth-button")?.click();

    expect(document.getElementById("auth-modal-title")?.textContent).toBe(
      "Login with Polkadot Mobile",
    );
    expect(loginRequests).toEqual([{ reason: undefined }]);
  });

  it("emits a login request on the first auth button click", async () => {
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
    expect(
      document.getElementById("auth-button")?.hasAttribute("disabled"),
    ).toBe(false);
    document.getElementById("auth-button")?.click();

    expect(loginRequests).toEqual([{ reason: undefined }]);
    expect(
      document
        .getElementById("auth-modal-backdrop")
        ?.classList.contains("open"),
    ).toBe(true);
  });

  it("keeps the pairing modal open through an unrelated disconnected state", async () => {
    installTopbarDom();
    const { initTopBar } = await import("@dotli/ui/topbar");
    initTopBar();

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

    expect(
      document
        .getElementById("auth-modal-backdrop")
        ?.classList.contains("open"),
    ).toBe(true);
  });

  it("keeps landing pairing presentation host-global", async () => {
    installTopbarDom();
    const { initTopBar } = await import("@dotli/ui/topbar");
    initTopBar();

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

    expect(document.getElementById("auth-modal-title")?.textContent).toBe(
      "Login with Polkadot Mobile",
    );
  });

  it("cancels the in-flight login when the user closes the pairing modal", async () => {
    installTopbarDom();
    const { initTopBar } = await import("@dotli/ui/topbar");
    initTopBar();
    let cancels = 0;
    window.addEventListener("dotli:truapi-cancel-login", () => {
      cancels += 1;
    });

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

    expect(cancels).toBe(1);
    expect(
      document
        .getElementById("auth-modal-backdrop")
        ?.classList.contains("open"),
    ).toBe(false);
    expect(document.getElementById("auth-modal-qr")?.children).toHaveLength(0);
  });

  it("closes the pairing modal when the session connects", async () => {
    installTopbarDom();
    const { initTopBar } = await import("@dotli/ui/topbar");
    initTopBar();
    let cancels = 0;
    window.addEventListener("dotli:truapi-cancel-login", () => {
      cancels += 1;
    });

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

    expect(
      document
        .getElementById("auth-modal-backdrop")
        ?.classList.contains("open"),
    ).toBe(false);
    expect(cancels).toBe(0);
    expect(document.getElementById("auth-button")?.textContent).toBe("PG");
  });

  it("keeps the retry view for login failures", async () => {
    installTopbarDom();
    const { initTopBar } = await import("@dotli/ui/topbar");
    initTopBar();

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
});

describe("topbar boot rehydration", () => {
  it("renders the persisted session badge on idle after init", async () => {
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

    const { initTopBar } = await import("@dotli/ui/topbar");
    initTopBar();
    await flushMicrotasks();

    expect(document.getElementById("auth-button")?.textContent).toBe("PG");
    expect(document.getElementById("user-popover-username")?.textContent).toBe(
      "pgherveou.04",
    );
  });

  it("stays logged out when no session is persisted", async () => {
    installTopbarDom();
    vi.stubGlobal("requestIdleCallback", (callback: () => void): number => {
      callback();
      return 0;
    });

    const { initTopBar } = await import("@dotli/ui/topbar");
    initTopBar();

    expect(
      document.getElementById("auth-button")?.querySelector(".user-badge"),
    ).toBeNull();
  });
});
