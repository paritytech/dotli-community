// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import { flush } from "solid-js";
import type {
  PermissionAuthorizationRequest,
  PermissionAuthorizationStatus,
} from "@parity/truapi-host";
import { PermissionsPopover } from "@dotli/ui/components/shell/PermissionsPopover";
import {
  ALL_PERMISSIONS,
  registerPermissionAuthorizationProvider,
} from "@dotli/ui/permissions";
import { setProductError, setProductLoaded } from "@dotli/ui/state/product";
import { recordPermissionChange } from "@dotli/ui/state/permissions";
import { setBlockingModalActive } from "@dotli/ui/state/topbar";
import {
  pointerPressUnfocusable,
  renderComponent,
  resetStores,
  tabTo,
} from "../../helpers/solid";
import {
  oldPermissionsBackdrop,
  oldPermissionsButton,
  oldPermissionsPopover,
  type OldPermissionsList,
} from "./old-permissions-markup";
import { normalized } from "./old-auth-markup";
import { mountMoreMenu, tapMoreRow } from "./more-menu-harness";

const LABEL = "localhost:3000";

let cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
  cleanups = [];
  resetStores();
  vi.restoreAllMocks();
});

/** The permission a request asks about. */
function nameOf(request: PermissionAuthorizationRequest): string {
  switch (request.tag) {
    case "Device":
      return request.value;
    case "Remote":
      return request.value.permission.tag;
    default:
      return request.tag;
  }
}

interface Provider {
  /** The stored statuses, by permission name ("NotDetermined" when absent). */
  stored: Map<string, PermissionAuthorizationStatus>;
  set: ReturnType<typeof vi.fn>;
}

/** A provider for `label` keeping statuses in memory, as the Rust core does. */
function provide(
  label = LABEL,
  initial: Record<string, PermissionAuthorizationStatus> = {},
): Provider {
  const stored = new Map(Object.entries(initial));
  const set = vi.fn(
    async (
      request: PermissionAuthorizationRequest,
      status: PermissionAuthorizationStatus,
    ) => {
      stored.set(nameOf(request), status);
    },
  );
  cleanups.push(
    registerPermissionAuthorizationProvider(label, {
      getPermissionAuthorizationStatuses: async (requests) =>
        requests.map(
          (request) => stored.get(nameOf(request)) ?? "NotDetermined",
        ),
      setPermissionAuthorizationStatus: set,
    }),
  );
  return { stored, set };
}

/** Records window events named `name` until the test ends. */
function recordEvents(name: string): unknown[] {
  const details: unknown[] = [];
  const listener = (event: Event): void => {
    details.push((event as CustomEvent).detail);
  };
  window.addEventListener(name, listener);
  cleanups.push(() => {
    window.removeEventListener(name, listener);
  });
  return details;
}

/** Let pending reads resolve and Solid apply what they wrote. */
async function settleAll(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    flush();
    await Promise.resolve();
  }
  flush();
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

async function renderPopover(): Promise<void> {
  renderComponent(() => (
    <div>
      <PermissionsPopover />
      <button id="outside" type="button">
        Outside
      </button>
    </div>
  ));
  await settleAll();
}

function isOpen(): boolean {
  return byId("permissions-popover").classList.contains("open");
}

async function openPopover(): Promise<void> {
  byId("permissions-button").click();
  await settleAll();
  expect(isOpen()).toBe(true);
}

function select(name: string): HTMLButtonElement {
  return byId(`permissions-popover-select-${name}`);
}

function menu(): HTMLElement | null {
  return document.querySelector(".permissions-popover-menu");
}

function option(label: string): HTMLButtonElement {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      ".permissions-popover-menu-item",
    ),
  ).find((item) => item.textContent === label) as HTMLButtonElement;
}

function expectPopover(opts: {
  open: boolean;
  list: OldPermissionsList;
}): void {
  expect(
    normalized(byId("permissions-popover")).isEqualNode(
      normalized(oldPermissionsPopover(opts)),
    ),
  ).toBe(true);
}

describe("PermissionsPopover", () => {
  it("As a dotli user, the button, backdrop and closed popover have the markup the topbar rendered", async () => {
    // When
    await renderPopover();

    // Then
    expect(
      normalized(byId("permissions-button")).isEqualNode(
        normalized(oldPermissionsButton({ open: false, hasGrants: false })),
      ),
    ).toBe(true);
    expect(
      normalized(byId("permissions-popover-backdrop")).isEqualNode(
        normalized(oldPermissionsBackdrop(false)),
      ),
    ).toBe(true);
    expectPopover({ open: false, list: { kind: "empty" } });
  });

  it("As a user of a loaded app, the popover lists every permission with its status, as the topbar did", async () => {
    // Given
    provide(LABEL, { Camera: "Authorized", ChainSubmit: "Denied" });
    setProductLoaded(LABEL, "app.dot");
    await renderPopover();

    // When
    await openPopover();

    // Then
    expect(document.querySelectorAll(".permissions-popover-row")).toHaveLength(
      ALL_PERMISSIONS.length,
    );
    expect(byId("permissions-popover-status-Camera").textContent).toBe(
      "Allowed",
    );
    expect(byId("permissions-popover-status-ChainSubmit").textContent).toBe(
      "Denied",
    );
    expect(byId("permissions-popover-status-Notifications").textContent).toBe(
      "Ask (Default)",
    );
    expectPopover({
      open: true,
      list: {
        kind: "rows",
        statuses: { Camera: "granted", ChainSubmit: "denied" },
      },
    });
    expect(
      normalized(byId("permissions-button")).isEqualNode(
        normalized(oldPermissionsButton({ open: true, hasGrants: true })),
      ),
    ).toBe(true);
    expect(
      normalized(byId("permissions-popover-backdrop")).isEqualNode(
        normalized(oldPermissionsBackdrop(true)),
      ),
    ).toBe(true);
    expect(document.activeElement).toBe(byId("permissions-popover"));

    // When
    select("Camera").click();
    await settleAll();

    // Then
    expectPopover({
      open: true,
      list: {
        kind: "rows",
        statuses: { Camera: "granted", ChainSubmit: "denied" },
        menuOpen: "Camera",
      },
    });
  });

  it("As a user with no app loaded yet, or none on this domain, the popover says so", async () => {
    // Given
    await renderPopover();

    // When
    await openPopover();

    // Then
    expectPopover({
      open: true,
      list: {
        kind: "hint",
        text: "Wait for the app to finish loading to change its permissions.",
      },
    });

    // When
    setProductError();
    await settleAll();

    // Then
    expectPopover({
      open: true,
      list: { kind: "hint", text: "No app is loaded on this domain." },
    });
  });

  it("As a user whose app's permissions cannot be read, the popover says they are unavailable", async () => {
    // Given
    cleanups.push(
      registerPermissionAuthorizationProvider(LABEL, {
        getPermissionAuthorizationStatuses: () =>
          Promise.reject(new Error("core down")),
        setPermissionAuthorizationStatus: async () => {},
      }),
    );
    setProductLoaded(LABEL, "app.dot");
    await renderPopover();

    // When
    await openPopover();

    // Then
    expectPopover({
      open: true,
      list: {
        kind: "hint",
        text: "Permissions are unavailable for this app.",
      },
    });
    expect(byId("permissions-button").classList.contains("has-grants")).toBe(
      false,
    );
  });

  it("As a user, allowing a permission stores it and announces { label, permission }; a device permission announces a device change", async () => {
    // Given
    const provider = provide(LABEL, { Camera: "Authorized" });
    const grants = recordEvents("dotli:permission-changed");
    const devices = recordEvents("dotli:device-permission-changed");
    setProductLoaded(LABEL, "app.dot");
    await renderPopover();
    await openPopover();

    // When
    select("Notifications").click();
    await settleAll();
    option("Allowed").click();
    await settleAll();

    // Then
    expect(provider.set).toHaveBeenCalledWith(
      { tag: "Device", value: "Notifications" },
      "Authorized",
    );
    expect(grants).toEqual([{ label: LABEL, permission: "Notifications" }]);
    expect(devices).toEqual([]);
    expect(byId("permissions-popover-status-Notifications").textContent).toBe(
      "Allowed",
    );
    expect(menu()).toBeNull();
    expect(isOpen()).toBe(true);

    // When: back to Ask resets it.
    select("Camera").click();
    await settleAll();
    option("Ask (Default)").click();
    await settleAll();

    // Then
    expect(provider.set).toHaveBeenLastCalledWith(
      { tag: "Device", value: "Camera" },
      "NotDetermined",
    );
    expect(devices).toEqual([{ label: LABEL, permission: "Camera" }]);
    expect(byId("permissions-popover-status-Camera").textContent).toBe(
      "Ask (Default)",
    );
  });

  it("As a user, a change that fails re-reads the statuses while the popover is open, and not once it is closed", async () => {
    // Given: every change waits until the test fails it; reads are counted.
    const changes: ((err: Error) => void)[] = [];
    let reads = 0;
    cleanups.push(
      registerPermissionAuthorizationProvider(LABEL, {
        getPermissionAuthorizationStatuses: async (requests) => {
          reads += 1;
          return requests.map(() => "NotDetermined" as const);
        },
        setPermissionAuthorizationStatus: () =>
          new Promise((_resolve, reject) => {
            changes.push(reject);
          }),
      }),
    );
    setProductLoaded(LABEL, "app.dot");
    await renderPopover();
    await openPopover();
    select("Notifications").click();
    await settleAll();
    option("Allowed").click();
    await settleAll();
    const beforeFailure = reads;

    // When: the change fails while the popover is open.
    changes[0](new Error("core down"));
    await settleAll();

    // Then
    expect(reads).toBe(beforeFailure + 1);

    // When: another change fails after the popover closed.
    select("Notifications").click();
    await settleAll();
    option("Denied").click();
    await settleAll();
    byId("permissions-button").click();
    await settleAll();
    expect(isOpen()).toBe(false);
    const afterClose = reads;
    changes[1](new Error("core down"));
    await settleAll();

    // Then: nothing is read until the next open.
    expect(reads).toBe(afterClose);
  });

  it("As a keyboard user, choosing a permission keeps my focus on that row's select", async () => {
    // Given
    provide();
    setProductLoaded(LABEL, "app.dot");
    await renderPopover();
    await openPopover();

    // When
    select("Camera").click();
    await settleAll();
    option("Allowed").click();
    await settleAll();

    // Then
    expect(document.activeElement).toBe(select("Camera"));
  });

  it("As a screen-reader user, each select is named after its permission and status, and its listbox is named and navigable with the arrow keys", async () => {
    // Given
    provide();
    setProductLoaded(LABEL, "app.dot");
    await renderPopover();
    await openPopover();

    // Then
    const labelText = (
      select("Notifications").getAttribute("aria-labelledby") ?? ""
    )
      .split(" ")
      .map((id) => byId(id).textContent)
      .join(" ");
    expect(labelText).toBe("Notifications Ask (Default)");
    expect(select("Notifications").getAttribute("aria-expanded")).toBe("false");

    // When
    select("Notifications").click();
    await settleAll();

    // Then
    expect(select("Notifications").getAttribute("aria-expanded")).toBe("true");
    expect(menu()?.getAttribute("aria-label")).toBe("Notifications permission");
    expect(document.activeElement).toBe(option("Ask (Default)"));

    // When
    const down = press("ArrowDown");

    // Then
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(option("Allowed"));

    // When: moving up from the first option wraps to the last.
    press("ArrowUp");
    press("ArrowUp");

    // Then
    expect(document.activeElement).toBe(option("Denied"));
  });

  it("As a keyboard user, Escape closes an open dropdown first, handing focus to its select, and the next Escape closes the popover", async () => {
    // Given
    provide();
    setProductLoaded(LABEL, "app.dot");
    await renderPopover();
    byId("permissions-button").focus();
    await openPopover();
    select("Camera").click();
    await settleAll();
    expect(menu()).not.toBeNull();

    // When
    press("Escape");
    await settleAll();

    // Then
    expect(menu()).toBeNull();
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(select("Camera"));

    // When
    press("Escape");
    await settleAll();

    // Then
    expect(isOpen()).toBe(false);
    expect(byId("permissions-button").getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(document.activeElement).toBe(byId("permissions-button"));
  });

  it("As a screen-reader user, the button announces the dialog it opens and whether it is open", async () => {
    // Given
    provide();
    setProductLoaded(LABEL, "app.dot");
    await renderPopover();
    const button = byId("permissions-button");
    const popover = byId("permissions-popover");

    // Then
    expect(popover.getAttribute("role")).toBe("dialog");
    expect(popover.getAttribute("aria-label")).toBe("Permissions");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-controls")).toBe("permissions-popover");
    expect(button.getAttribute("aria-expanded")).toBe("false");

    // When
    await openPopover();

    // Then
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("As a keyboard user, opening it moves focus in, and Tab past the last select closes it and focus moves on", async () => {
    // Given
    provide();
    setProductLoaded(LABEL, "app.dot");
    await renderPopover();
    byId("permissions-button").focus();

    // When
    await openPopover();

    // Then
    expect(byId("permissions-popover").contains(document.activeElement)).toBe(
      true,
    );

    // Given
    const selects = byId("permissions-popover").querySelectorAll<HTMLElement>(
      ".permissions-popover-select",
    );
    expect(selects.length).toBeGreaterThan(0);
    selects[selects.length - 1].focus();
    await settleAll();
    expect(isOpen()).toBe(true);

    // When
    const tab = tabTo(byId("outside"));
    await settleAll();

    // Then
    expect(tab.defaultPrevented).toBe(false);
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(byId("outside"));
  });

  it("As a user, a press on the backdrop closes the popover without handing focus back to the button", async () => {
    // Given
    provide();
    setProductLoaded(LABEL, "app.dot");
    await renderPopover();
    byId("permissions-button").focus();
    await openPopover();

    // When: the backdrop covers the page, and takes no focus.
    pointerPressUnfocusable(byId("permissions-popover-backdrop"));
    await settleAll();

    // Then: focus follows the press.
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it("As a user, a click outside a row closes its dropdown, a second select opens in its place, and a click on the backdrop closes the popover", async () => {
    // Given
    provide();
    setProductLoaded(LABEL, "app.dot");
    await renderPopover();
    await openPopover();
    select("Camera").click();
    await settleAll();

    // When
    select("Microphone").click();
    await settleAll();

    // Then
    expect(document.querySelectorAll(".permissions-popover-menu")).toHaveLength(
      1,
    );
    expect(menu()?.getAttribute("aria-label")).toBe("Microphone permission");
    expect(select("Camera").getAttribute("aria-expanded")).toBe("false");

    // When: the same select again closes it.
    select("Microphone").click();
    await settleAll();

    // Then
    expect(menu()).toBeNull();

    // When
    select("Camera").click();
    await settleAll();
    document.querySelector<HTMLElement>(".permissions-popover-header")?.click();
    await settleAll();

    // Then
    expect(menu()).toBeNull();
    expect(isOpen()).toBe(true);

    // When
    byId("permissions-popover-backdrop").click();
    await settleAll();

    // Then
    expect(isOpen()).toBe(false);
    expect(
      byId("permissions-popover-backdrop").classList.contains("open"),
    ).toBe(false);
  });

  it("As a user, the button toggles the popover, and a blocking modal coming up closes it", async () => {
    // Given
    provide();
    setProductLoaded(LABEL, "app.dot");
    await renderPopover();
    await openPopover();

    // When
    byId("permissions-button").click();
    await settleAll();

    // Then
    expect(isOpen()).toBe(false);

    // When
    await openPopover();
    select("Camera").click();
    await settleAll();
    setBlockingModalActive(true);
    await settleAll();

    // Then
    expect(isOpen()).toBe(false);
    expect(menu()).toBeNull();
  });

  it("As a user, the lock button shows .has-grants while the app has any permission granted, including an app loaded before the island mounted", async () => {
    // Given
    const provider = provide(LABEL, { ChainSubmit: "Authorized" });
    setProductLoaded(LABEL, "app.dot");

    // When
    await renderPopover();

    // Then
    expect(byId("permissions-button").classList.contains("has-grants")).toBe(
      true,
    );

    // When
    provider.stored.clear();
    recordPermissionChange({
      kind: "grant",
      label: LABEL,
      permission: "ChainSubmit",
    });
    await settleAll();

    // Then
    expect(byId("permissions-button").classList.contains("has-grants")).toBe(
      false,
    );

    // When
    provider.stored.set("Camera", "Authorized");
    recordPermissionChange({
      kind: "device",
      label: LABEL,
      permission: "Camera",
    });
    await settleAll();

    // Then
    expect(byId("permissions-button").classList.contains("has-grants")).toBe(
      true,
    );

    // When
    setProductError();
    await settleAll();

    // Then
    expect(byId("permissions-button").classList.contains("has-grants")).toBe(
      false,
    );
  });

  it("As a user, when reads overlap, the last one wins: a slow earlier read never replaces a newer one", async () => {
    // Given: every read waits until the test answers it.
    const reads: {
      resolve: (statuses: PermissionAuthorizationStatus[]) => void;
      count: number;
    }[] = [];
    cleanups.push(
      registerPermissionAuthorizationProvider(LABEL, {
        getPermissionAuthorizationStatuses: (requests) =>
          new Promise((resolve) => {
            reads.push({ resolve, count: requests.length });
          }),
        setPermissionAuthorizationStatus: async () => {},
      }),
    );
    setProductLoaded(LABEL, "app.dot");
    await renderPopover();
    const all = (status: PermissionAuthorizationStatus) =>
      ALL_PERMISSIONS.map(() => status);

    // When: opening reads (after the mount's .has-grants read), then a
    // permission change reads again, for the class and for the list.
    await openPopover();
    const beforeChange = reads.length;
    window.dispatchEvent(
      new CustomEvent("dotli:permission-changed", {
        detail: { label: LABEL, permission: "Camera" },
      }),
    );
    await settleAll();
    const newer = reads.slice(beforeChange);
    const older = reads.slice(0, beforeChange);
    expect(older.length).toBeGreaterThanOrEqual(2);
    expect(newer).toHaveLength(2);
    for (const read of newer) {
      read.resolve(all("Denied"));
    }
    await settleAll();
    for (const read of older) {
      read.resolve(all("Authorized"));
    }
    await settleAll();

    // Then
    expect(byId("permissions-popover-status-Camera").textContent).toBe(
      "Denied",
    );
    expect(byId("permissions-button").classList.contains("has-grants")).toBe(
      false,
    );
  });

  it("As a user, when the app changes while the popover is open, the previous app's statuses are never shown for it", async () => {
    // Given
    provide(LABEL, { Camera: "Authorized" });
    provide("other.dot");
    setProductLoaded(LABEL, "app.dot");
    await renderPopover();
    await openPopover();
    expect(byId("permissions-popover-status-Camera").textContent).toBe(
      "Allowed",
    );

    // When
    setProductLoaded("other.dot", "other.dot");
    flush();

    // Then: nothing until the new app's read lands, then its statuses.
    expect(document.querySelectorAll(".permissions-popover-row")).toHaveLength(
      0,
    );
    await settleAll();
    expect(byId("permissions-popover-status-Camera").textContent).toBe(
      "Ask (Default)",
    );
  });

  it("As a user of an app whose label contains markup, it is only ever passed on as text", async () => {
    // Given
    const label = '<img id="injected" src="x">';
    const provider = provide(label);
    const grants = recordEvents("dotli:permission-changed");
    setProductLoaded(label, "app.dot");
    await renderPopover();

    // When
    await openPopover();
    select("Notifications").click();
    await settleAll();
    option("Allowed").click();
    await settleAll();

    // Then
    expect(document.getElementById("injected")).toBeNull();
    expect(byId("permissions-popover").querySelector("img")).toBeNull();
    expect(provider.set).toHaveBeenCalledTimes(1);
    expect(grants).toEqual([{ label, permission: "Notifications" }]);
  });

  it("As a mobile user, the More menu's Permissions row opens the popover by clicking the button it looks up by id", async () => {
    // Given: the real More menu, mounted as its own island.
    provide();
    setProductLoaded(LABEL, "app.dot");
    await renderPopover();
    cleanups.push(mountMoreMenu());

    // When
    await tapMoreRow("permissions-button");
    await settleAll();

    // Then
    expect(
      document.getElementById("more-popover")?.classList.contains("open"),
    ).toBe(false);
    expect(isOpen()).toBe(true);
    expect(document.querySelectorAll(".permissions-popover-row")).toHaveLength(
      ALL_PERMISSIONS.length,
    );
  });
});
