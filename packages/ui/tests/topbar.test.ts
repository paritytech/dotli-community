import { beforeEach, describe, expect, it, vi } from "vitest";
import { stubColorScheme } from "./helpers/color-scheme";

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
  // initTopBar's block source, read by the network store it starts.
  isRemoteChainConnectable: () => false,
}));

const device = vi.hoisted(() => ({ mobile: false }));

vi.mock("@dotli/shared/device", () => ({
  isMobileDevice: () => device.mobile,
}));

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function installTopbarDom(): void {
  document.body.innerHTML = `
    <a id="topbar-home"></a>
  `;
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  device.mobile = false;
  localStorage.clear();
  sharedAuth.storage.clear();
  sharedAuth.listeners.clear();
  document.body.innerHTML = "";
});

// The auth button, the user popover and the pairing modal are islands now:
// their tests are tests/components/shell/auth-button, user-popover and
// auth-modal, and the controller's are tests/auth-controller.test.ts. The
// permissions popover is an island too: tests/components/shell/
// permissions-popover.test.tsx. So are the network popover
// (chains-popover.test.tsx) and the settings popover
// (settings-popover.test.tsx).

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
    const { getAuthState, getLoggedIn } = await import("@dotli/ui/state/auth");
    initTopBar();
    await flushMicrotasks();

    // Then: the stores the auth islands render, whenever they mount.
    expect(getAuthState()).toEqual({
      tag: "Connected",
      session: {
        connected: true,
        publicKey:
          "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
        liteUsername: "pgherveou.04",
        primaryUsername: "pgherveou.04",
      },
    });
    expect(getLoggedIn()).toBe(true);
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
    const { getAuthState, getLoggedIn } = await import("@dotli/ui/state/auth");
    initTopBar();
    await flushMicrotasks();

    // Then
    expect(getAuthState()).toEqual({ tag: "Disconnected" });
    expect(getLoggedIn()).toBe(false);
  });
});

// The theme menu itself is components/shell/ThemeToggle.tsx (tested in
// tests/components/shell/theme-toggle.test.tsx) and the preference logic is
// theme-controller.ts (tests/theme-controller.test.ts). The topbar keeps
// applying the stored preference at initTopBar(), as before.
describe("topbar theme", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-theme-pref");
  });

  it("As a dotli user, initTopBar applies my stored theme", async () => {
    // Given
    installTopbarDom();
    stubColorScheme("dark");
    localStorage.setItem("dotli-theme", "light");
    const { initTopBar } = await import("@dotli/ui/topbar");
    const { getThemeState } = await import("@dotli/ui/state/theme");

    // When
    initTopBar();

    // Then
    expect(document.documentElement.getAttribute("data-theme-pref")).toBe(
      "light",
    );
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(getThemeState()).toEqual({ pref: "light", resolved: "light" });
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

  it("As a dotli user, the System option follows OS theme changes after initTopBar", async () => {
    // Given
    installTopbarDom();
    const os = stubColorScheme("dark");
    localStorage.setItem("dotli-theme", "system");
    const { initTopBar } = await import("@dotli/ui/topbar");
    initTopBar();

    // When
    os.set("light");

    // Then
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
