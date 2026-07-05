// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  AUTO_GRANT_DEVICE_PERMISSIONS,
  DEVICE_PERMISSION_POLICY,
  buildAllowAttribute,
  getGrantedDevicePermissions,
  getPermissionStatuses,
  getPermissionStatus,
  hasAnyGrant,
  isDevicePermission,
  isEnforceableDevicePermission,
  registerPermissionAuthorizationProvider,
  resetPermission,
  setPermissionStatus,
} from "@dotli/ui/permissions";
import type {
  PermissionAuthorizationRequest,
  PermissionAuthorizationStatus,
} from "@parity/truapi-host-wasm";

type Store = Map<string, PermissionAuthorizationStatus>;

let unregisterMyapp: (() => void) | null = null;
let myappStore: Store;
let myappBatchReads = 0;

beforeEach(() => {
  myappStore = new Map();
  myappBatchReads = 0;
  unregisterMyapp = registerTestProvider("myapp", myappStore);
});

afterEach(() => {
  unregisterMyapp?.();
  unregisterMyapp = null;
});

function registerTestProvider(label: string, store: Store): () => void {
  return registerPermissionAuthorizationProvider(label, {
    async getPermissionAuthorizationStatuses(requests) {
      if (label === "myapp") {
        myappBatchReads += 1;
      }
      return requests.map(
        (request) => store.get(requestKey(request)) ?? "NotDetermined",
      );
    },
    async setPermissionAuthorizationStatus(request, status) {
      const key = requestKey(request);
      if (status === "NotDetermined") {
        store.delete(key);
      } else {
        store.set(key, status);
      }
    },
  });
}

function requestKey(request: PermissionAuthorizationRequest): string {
  switch (request.tag) {
    case "Device":
      return `Device:${request.value}`;
    case "Remote":
      return `Remote:${request.value.permission.tag}`;
    case "IdentityDisclosure":
      return "IdentityDisclosure";
  }
}

describe("getPermissionStatus / setPermissionStatus", () => {
  it("returns 'ask' by default", async () => {
    expect(await getPermissionStatus("myapp", "Camera")).toBe("ask");
    expect(await getPermissionStatus("myapp", "ChainSubmit")).toBe("ask");
    expect(await getPermissionStatus("myapp", "IdentityDisclosure")).toBe(
      "ask",
    );
  });

  it("round-trips a granted status", async () => {
    await setPermissionStatus("myapp", "Camera", "granted");
    expect(await getPermissionStatus("myapp", "Camera")).toBe("granted");
  });

  it("round-trips a denied status", async () => {
    await setPermissionStatus("myapp", "ChainSubmit", "denied");
    expect(await getPermissionStatus("myapp", "ChainSubmit")).toBe("denied");
  });

  it("uses the core-backed authorization store", async () => {
    await setPermissionStatus("myapp", "ChainSubmit", "granted");
    await setPermissionStatus("myapp", "Camera", "denied");
    await setPermissionStatus("myapp", "IdentityDisclosure", "granted");

    expect(myappStore).toEqual(
      new Map([
        ["Remote:ChainSubmit", "Authorized"],
        ["Device:Camera", "Denied"],
        ["IdentityDisclosure", "Authorized"],
      ]),
    );
    expect(await getPermissionStatus("myapp", "ChainSubmit")).toBe("granted");
    expect(await getPermissionStatus("myapp", "Camera")).toBe("denied");
    expect(await getPermissionStatus("myapp", "IdentityDisclosure")).toBe(
      "granted",
    );
  });

  it("reads multiple statuses in one provider call", async () => {
    await setPermissionStatus("myapp", "ChainSubmit", "granted");
    await setPermissionStatus("myapp", "Camera", "denied");
    const callsBeforeRead = myappBatchReads;

    await expect(
      getPermissionStatuses("myapp", ["ChainSubmit", "Camera", "Microphone"]),
    ).resolves.toEqual(["granted", "denied", "ask"]);
    expect(myappBatchReads - callsBeforeRead).toBe(1);
  });

  it("isolates grants per product label", async () => {
    await setPermissionStatus("myapp", "Camera", "granted");
    expect(await getPermissionStatus("otherapp", "Camera")).toBe("ask");
  });
});

describe("resetPermission", () => {
  it("removes one entry without affecting others on the same label", async () => {
    await setPermissionStatus("myapp", "Camera", "granted");
    await setPermissionStatus("myapp", "ChainSubmit", "granted");

    await resetPermission("myapp", "Camera");

    expect(await getPermissionStatus("myapp", "Camera")).toBe("ask");
    expect(await getPermissionStatus("myapp", "ChainSubmit")).toBe("granted");
  });

  it("is a no-op for unknown entries", async () => {
    await resetPermission("myapp", "Camera");
    expect(await getPermissionStatus("myapp", "Camera")).toBe("ask");
  });
});

describe("hasAnyGrant", () => {
  it("returns false for a fresh label", async () => {
    expect(await hasAnyGrant("myapp")).toBe(false);
  });

  it("returns true after any grant", async () => {
    await setPermissionStatus("myapp", "IdentityDisclosure", "granted");
    expect(await hasAnyGrant("myapp")).toBe(true);
  });

  it("returns false when only denials exist", async () => {
    await setPermissionStatus("myapp", "Camera", "denied");
    await setPermissionStatus("myapp", "ChainSubmit", "denied");
    await setPermissionStatus("myapp", "IdentityDisclosure", "denied");
    expect(await hasAnyGrant("myapp")).toBe(false);
  });

  it("returns false again after the only grant is reset", async () => {
    await setPermissionStatus("myapp", "Camera", "granted");
    await resetPermission("myapp", "Camera");
    expect(await hasAnyGrant("myapp")).toBe(false);
  });
});

describe("isDevicePermission", () => {
  it("identifies entries in DEVICE_PERMISSION_POLICY", () => {
    expect(isDevicePermission("Camera")).toBe(true);
    expect(isDevicePermission("Microphone")).toBe(true);
    expect(isDevicePermission("Bluetooth")).toBe(true);
    expect(isDevicePermission("Location")).toBe(true);
    expect(isDevicePermission("Clipboard")).toBe(true);
    expect(isDevicePermission("Biometrics")).toBe(true);
    expect(isDevicePermission("NFC")).toBe(true);
  });

  it("rejects submit-style permissions", () => {
    expect(isDevicePermission("ChainSubmit")).toBe(false);
    expect(isDevicePermission("PreimageSubmit")).toBe(false);
    expect(isDevicePermission("StatementSubmit")).toBe(false);
    expect(isDevicePermission("IdentityDisclosure")).toBe(false);
  });

  it("rejects device permissions absent from the policy map", () => {
    // Notifications is host-gated separately (see handleDevicePermission)
    // but has no Permissions Policy directive. OpenUrl is auto-granted.
    expect(isDevicePermission("Notifications")).toBe(false);
    expect(isDevicePermission("OpenUrl")).toBe(false);
  });
});

describe("isEnforceableDevicePermission", () => {
  it("rejects auto-granted device permissions", () => {
    expect(isEnforceableDevicePermission("OpenUrl")).toBe(false);
  });

  it("accepts gateable device permissions", () => {
    expect(isEnforceableDevicePermission("Notifications")).toBe(true);
    expect(isEnforceableDevicePermission("Camera")).toBe(true);
    expect(isEnforceableDevicePermission("Microphone")).toBe(true);
    expect(isEnforceableDevicePermission("Notifications")).toBe(true);
  });
});

describe("getGrantedDevicePermissions", () => {
  it("returns only granted device permissions, ignoring core-only grants", async () => {
    await setPermissionStatus("myapp", "Camera", "granted");
    await setPermissionStatus("myapp", "Microphone", "denied");
    await setPermissionStatus("myapp", "ChainSubmit", "granted");
    await setPermissionStatus("myapp", "IdentityDisclosure", "granted");

    expect(await getGrantedDevicePermissions("myapp")).toEqual(["Camera"]);
  });

  it("returns an empty array when only submit-style grants exist", async () => {
    await setPermissionStatus("myapp", "ChainSubmit", "granted");
    await setPermissionStatus("myapp", "PreimageSubmit", "granted");
    expect(await getGrantedDevicePermissions("myapp")).toEqual([]);
  });
});

describe("buildAllowAttribute", () => {
  it("always includes clipboard-write", async () => {
    expect(await buildAllowAttribute("myapp")).toBe("clipboard-write");
  });

  it("appends Permissions Policy directives for granted device permissions", async () => {
    await setPermissionStatus("myapp", "Camera", "granted");
    await setPermissionStatus("myapp", "Microphone", "granted");

    // Order follows JSON insertion order, so assert on the directive set.
    const directives = (await buildAllowAttribute("myapp")).split("; ").sort();
    expect(directives).toEqual(["camera", "clipboard-write", "microphone"]);
  });

  it("excludes denied device permissions and submit-style grants", async () => {
    await setPermissionStatus("myapp", "Camera", "denied");
    await setPermissionStatus("myapp", "ChainSubmit", "granted");
    expect(await buildAllowAttribute("myapp")).toBe("clipboard-write");
  });
});

describe("ALL_PERMISSIONS (data invariants)", () => {
  it("only references EnforceablePermissionName values", () => {
    for (const { name } of ALL_PERMISSIONS) {
      expect(AUTO_GRANT_DEVICE_PERMISSIONS.has(name as never)).toBe(false);
    }
  });

  it("uses the canonical v0.7 wire tags for submit gates", () => {
    const names = ALL_PERMISSIONS.map((p) => p.name);
    expect(names).toContain("ChainSubmit");
    expect(names).toContain("IdentityDisclosure");
    expect(names).toContain("PreimageSubmit");
    expect(names).toContain("StatementSubmit");
    expect(names).toContain("Notifications");
    expect(names).not.toContain("TransactionSubmit");
  });
});

describe("DEVICE_PERMISSION_POLICY (sanity)", () => {
  it("does not list auto-granted device permissions", () => {
    for (const auto of AUTO_GRANT_DEVICE_PERMISSIONS) {
      expect(auto in DEVICE_PERMISSION_POLICY).toBe(false);
    }
  });
});
