import { beforeEach, describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  AUTO_GRANT_DEVICE_PERMISSIONS,
  DEVICE_PERMISSION_POLICY,
  buildAllowAttribute,
  getGrantedDevicePermissions,
  getPermissionStatus,
  hasAnyGrant,
  isDevicePermission,
  isEnforceableDevicePermission,
  resetPermission,
  setPermissionStatus,
} from "@dotli/ui/permissions";

beforeEach(() => {
  localStorage.clear();
});

describe("getPermissionStatus / setPermissionStatus", () => {
  it("returns 'ask' by default", () => {
    expect(getPermissionStatus("myapp", "Camera")).toBe("ask");
    expect(getPermissionStatus("myapp", "ChainSubmit")).toBe("ask");
  });

  it("round-trips a granted status", () => {
    setPermissionStatus("myapp", "Camera", "granted");
    expect(getPermissionStatus("myapp", "Camera")).toBe("granted");
  });

  it("round-trips a denied status", () => {
    setPermissionStatus("myapp", "ChainSubmit", "denied");
    expect(getPermissionStatus("myapp", "ChainSubmit")).toBe("denied");
  });

  it("persists across a reload (raw localStorage shape)", () => {
    setPermissionStatus("myapp", "ChainSubmit", "granted");
    setPermissionStatus("myapp", "Camera", "denied");

    // What a reloaded tab would observe directly in localStorage.
    const raw = localStorage.getItem("dotli:permissions:myapp");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({
      ChainSubmit: "granted",
      Camera: "denied",
    });

    // And the public API surfaces those values without any priming.
    expect(getPermissionStatus("myapp", "ChainSubmit")).toBe("granted");
    expect(getPermissionStatus("myapp", "Camera")).toBe("denied");
  });

  it("isolates grants per product label", () => {
    setPermissionStatus("myapp", "Camera", "granted");
    expect(getPermissionStatus("otherapp", "Camera")).toBe("ask");
  });

  it("falls back to 'ask' when localStorage holds malformed JSON", () => {
    localStorage.setItem("dotli:permissions:myapp", "{ not json");
    expect(getPermissionStatus("myapp", "Camera")).toBe("ask");
  });
});

describe("resetPermission", () => {
  it("removes one entry without affecting others on the same label", () => {
    setPermissionStatus("myapp", "Camera", "granted");
    setPermissionStatus("myapp", "ChainSubmit", "granted");

    resetPermission("myapp", "Camera");

    expect(getPermissionStatus("myapp", "Camera")).toBe("ask");
    expect(getPermissionStatus("myapp", "ChainSubmit")).toBe("granted");
  });

  it("is a no-op for unknown entries", () => {
    resetPermission("myapp", "Camera");
    expect(getPermissionStatus("myapp", "Camera")).toBe("ask");
  });
});

describe("hasAnyGrant", () => {
  it("returns false for a fresh label", () => {
    expect(hasAnyGrant("myapp")).toBe(false);
  });

  it("returns true after any grant", () => {
    setPermissionStatus("myapp", "Camera", "granted");
    expect(hasAnyGrant("myapp")).toBe(true);
  });

  it("returns false when only denials exist", () => {
    setPermissionStatus("myapp", "Camera", "denied");
    setPermissionStatus("myapp", "ChainSubmit", "denied");
    expect(hasAnyGrant("myapp")).toBe(false);
  });

  it("returns false again after the only grant is reset", () => {
    setPermissionStatus("myapp", "Camera", "granted");
    resetPermission("myapp", "Camera");
    expect(hasAnyGrant("myapp")).toBe(false);
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
  });

  it("rejects auto-granted device permissions absent from the policy map", () => {
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
  });
});

describe("getGrantedDevicePermissions", () => {
  it("returns only granted device permissions, ignoring submit-style grants", () => {
    setPermissionStatus("myapp", "Camera", "granted");
    setPermissionStatus("myapp", "Microphone", "denied");
    setPermissionStatus("myapp", "ChainSubmit", "granted");

    expect(getGrantedDevicePermissions("myapp")).toEqual(["Camera"]);
  });

  it("returns an empty array when only submit-style grants exist", () => {
    setPermissionStatus("myapp", "ChainSubmit", "granted");
    setPermissionStatus("myapp", "PreimageSubmit", "granted");
    expect(getGrantedDevicePermissions("myapp")).toEqual([]);
  });
});

describe("buildAllowAttribute", () => {
  it("always includes clipboard-write", () => {
    expect(buildAllowAttribute("myapp")).toBe("clipboard-write");
  });

  it("appends Permissions Policy directives for granted device permissions", () => {
    setPermissionStatus("myapp", "Camera", "granted");
    setPermissionStatus("myapp", "Microphone", "granted");

    // Order follows JSON insertion order; assert on the directive set.
    const directives = buildAllowAttribute("myapp").split("; ").sort();
    expect(directives).toEqual(["camera", "clipboard-write", "microphone"]);
  });

  it("excludes denied device permissions and submit-style grants", () => {
    setPermissionStatus("myapp", "Camera", "denied");
    setPermissionStatus("myapp", "ChainSubmit", "granted");
    expect(buildAllowAttribute("myapp")).toBe("clipboard-write");
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
    expect(names).toContain("PreimageSubmit");
    expect(names).toContain("StatementSubmit");
    expect(names).toContain("UserId");
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
