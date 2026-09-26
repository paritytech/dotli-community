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
  device.mobile = false;
  localStorage.clear();
  sharedAuth.storage.clear();
  sharedAuth.listeners.clear();
  document.body.innerHTML = "";
});

// The auth button, the user popover and the pairing modal are islands now:
// their tests are tests/components/shell/auth-button, user-popover and
// auth-modal, and the controller's are tests/auth-controller.test.ts.

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
      '[role="radiogroup"][aria-label="Network Transport"]',
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
