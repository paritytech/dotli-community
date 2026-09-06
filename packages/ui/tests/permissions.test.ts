// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
} from "@parity/truapi-host";
import { createPromptPermission } from "@dotli/ui/host-callbacks/PromptPermission";
import { createBlockingModalScope } from "@dotli/ui/blocking-modal-queue";

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
  it("As a product, my permissions default to ask", async () => {
    expect(await getPermissionStatus("myapp", "Camera")).toBe("ask");
    expect(await getPermissionStatus("myapp", "ChainSubmit")).toBe("ask");
    expect(await getPermissionStatus("myapp", "IdentityDisclosure")).toBe(
      "ask",
    );
  });

  it("As a product, my status defaults to ask when the provider returns fewer statuses than requested", async () => {
    // Given: a provider that violates the length contract.
    const unregister = registerPermissionAuthorizationProvider("shortapp", {
      async getPermissionAuthorizationStatuses() {
        return [];
      },
      async setPermissionAuthorizationStatus() {
        return;
      },
    });

    try {
      // Then: the missing entry surfaces as "ask", not undefined.
      expect(await getPermissionStatus("shortapp", "Camera")).toBe("ask");
    } finally {
      unregister();
    }
  });

  it("As a product, my granted permission status is preserved", async () => {
    await setPermissionStatus("myapp", "Camera", "granted");
    expect(await getPermissionStatus("myapp", "Camera")).toBe("granted");
  });

  it("As a product, my denied permission status is preserved", async () => {
    await setPermissionStatus("myapp", "ChainSubmit", "denied");
    expect(await getPermissionStatus("myapp", "ChainSubmit")).toBe("denied");
  });

  it("As a product, my permission decisions use the core authorization store", async () => {
    // Given
    expect(myappStore).toEqual(new Map());

    // When
    await setPermissionStatus("myapp", "ChainSubmit", "granted");
    await setPermissionStatus("myapp", "Camera", "denied");
    await setPermissionStatus("myapp", "IdentityDisclosure", "granted");

    // Then
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

  it("As a product, my permission statuses are read in one provider call", async () => {
    // Given
    await setPermissionStatus("myapp", "ChainSubmit", "granted");
    await setPermissionStatus("myapp", "Camera", "denied");
    const callsBeforeRead = myappBatchReads;

    // When
    const statuses = getPermissionStatuses("myapp", [
      "ChainSubmit",
      "Camera",
      "Microphone",
    ]);

    // Then
    await expect(statuses).resolves.toEqual(["granted", "denied", "ask"]);
    expect(myappBatchReads - callsBeforeRead).toBe(1);
  });

  it("As a product, my permission grants are isolated from other products", async () => {
    await setPermissionStatus("myapp", "Camera", "granted");
    expect(await getPermissionStatus("otherapp", "Camera")).toBe("ask");
  });

  it("As a product, my active permission provider survives a failed replacement", async () => {
    // Given
    await setPermissionStatus("myapp", "Camera", "granted");
    const replacementStore: Store = new Map([["Device:Camera", "Denied"]]);
    const unregisterReplacement = registerTestProvider(
      "myapp",
      replacementStore,
    );

    // Then
    expect(await getPermissionStatus("myapp", "Camera")).toBe("denied");

    // When
    unregisterReplacement();

    // Then
    expect(await getPermissionStatus("myapp", "Camera")).toBe("granted");
  });
});

describe("resetPermission", () => {
  it("As a product, I can reset one permission without affecting my others", async () => {
    // Given
    await setPermissionStatus("myapp", "Camera", "granted");
    await setPermissionStatus("myapp", "ChainSubmit", "granted");

    // When
    await resetPermission("myapp", "Camera");

    // Then
    expect(await getPermissionStatus("myapp", "Camera")).toBe("ask");
    expect(await getPermissionStatus("myapp", "ChainSubmit")).toBe("granted");
  });

  it("As a product, resetting an unknown permission leaves my grants unchanged", async () => {
    await resetPermission("myapp", "Camera");
    expect(await getPermissionStatus("myapp", "Camera")).toBe("ask");
  });
});

describe("hasAnyGrant", () => {
  it("As a new product, I have no persisted grants", async () => {
    expect(await hasAnyGrant("myapp")).toBe(false);
  });

  it("As a product, I have persisted grants after one permission is allowed", async () => {
    await setPermissionStatus("myapp", "IdentityDisclosure", "granted");
    expect(await hasAnyGrant("myapp")).toBe(true);
  });

  it("As a product, denied permissions do not count as persisted grants", async () => {
    await setPermissionStatus("myapp", "Camera", "denied");
    await setPermissionStatus("myapp", "ChainSubmit", "denied");
    await setPermissionStatus("myapp", "IdentityDisclosure", "denied");
    expect(await hasAnyGrant("myapp")).toBe(false);
  });

  it("As a product, I have no persisted grants after resetting my only grant", async () => {
    // Given
    await setPermissionStatus("myapp", "Camera", "granted");

    // When
    await resetPermission("myapp", "Camera");

    // Then
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
  });
});

describe("device permission prompts", () => {
  async function grantAndCountReloads(
    permission: "Camera" | "Notifications",
  ): Promise<number> {
    let reloads = 0;
    const onReload = (): void => {
      reloads += 1;
    };
    window.addEventListener("dotli:device-permission-changed", onReload);

    const response =
      createPromptPermission("myapp").devicePermission(permission);
    await vi.waitFor(() => {
      expect(document.querySelector(".signing-btn-sign")).not.toBeNull();
    });
    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();
    await expect(response).resolves.toEqual({ granted: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    window.removeEventListener("dotli:device-permission-changed", onReload);
    document.body.replaceChildren();
    return reloads;
  }

  it("As a product, my iframe stays alive when notifications are granted", async () => {
    expect(await grantAndCountReloads("Notifications")).toBe(0);
  });

  it("As a product, my iframe reloads when a grant changes its allow attribute", async () => {
    expect(await grantAndCountReloads("Camera")).toBe(1);
  });
});

describe("remote domain permission prompts", () => {
  const request = {
    permission: {
      tag: "Remote" as const,
      value: { domains: ["API.Example"] },
    },
  };

  it("memoizes decisions for one callback session without persisting them", async () => {
    const session = createPromptPermission("myapp");
    const first = session.remotePermission(request);
    await vi.waitFor(() => {
      expect(document.querySelector(".signing-btn-sign")).not.toBeNull();
    });
    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();
    await expect(first).resolves.toEqual({ granted: true });
    expect(myappStore).toEqual(new Map());

    await expect(
      session.remotePermission({
        permission: {
          tag: "Remote",
          value: { domains: ["api.example"] },
        },
      }),
    ).resolves.toEqual({ granted: true });
    expect(document.querySelector(".signing-modal-backdrop")).toBeNull();

    const nextSession = createPromptPermission("myapp");
    const reconsidered = nextSession.remotePermission(request);
    await vi.waitFor(() => {
      expect(document.querySelector(".signing-btn-cancel")).not.toBeNull();
    });
    document.querySelector<HTMLButtonElement>(".signing-btn-cancel")?.click();
    await expect(reconsidered).resolves.toEqual({ granted: false });
    expect(myappStore).toEqual(new Map());
    document.body.replaceChildren();
  });

  it("bounds concurrently pending remote permission prompts", async () => {
    const scope = createBlockingModalScope();
    const session = createPromptPermission("myapp", scope);
    const pending = Array.from({ length: 5 }, (_, index) =>
      session.remotePermission({
        permission: {
          tag: "Remote",
          value: { domains: [`host-${String(index)}.example`] },
        },
      }),
    );

    await expect(pending[4]).resolves.toEqual({ granted: false });
    await vi.waitFor(() => {
      expect(document.querySelector(".signing-modal-backdrop")).not.toBeNull();
    });
    scope.dispose("test complete");
    await Promise.allSettled(pending.slice(0, 4));
    expect(document.querySelector(".signing-modal-backdrop")).toBeNull();
  });
});

describe("getGrantedDevicePermissions", () => {
  it("As a product, my iframe receives only granted device permissions", async () => {
    // Given
    await setPermissionStatus("myapp", "Camera", "granted");
    await setPermissionStatus("myapp", "Microphone", "denied");
    await setPermissionStatus("myapp", "ChainSubmit", "granted");
    await setPermissionStatus("myapp", "IdentityDisclosure", "granted");

    // When
    const permissions = await getGrantedDevicePermissions("myapp");

    // Then
    expect(permissions).toEqual(["Camera"]);
  });

  it("As a product, submit permissions do not alter my iframe policy", async () => {
    // Given
    await setPermissionStatus("myapp", "ChainSubmit", "granted");
    await setPermissionStatus("myapp", "PreimageSubmit", "granted");

    // When
    const permissions = await getGrantedDevicePermissions("myapp");

    // Then
    expect(permissions).toEqual([]);
  });
});

describe("buildAllowAttribute", () => {
  it("As a product, my iframe always receives clipboard-write access", async () => {
    expect(await buildAllowAttribute("myapp")).toBe("clipboard-write");
  });

  it("As a product, my granted device permissions appear in iframe policy", async () => {
    // Given
    await setPermissionStatus("myapp", "Camera", "granted");
    await setPermissionStatus("myapp", "Microphone", "granted");

    // When
    // Order follows JSON insertion order, so assert on the directive set.
    const directives = (await buildAllowAttribute("myapp")).split("; ").sort();

    // Then
    expect(directives).toEqual(["camera", "clipboard-write", "microphone"]);
  });

  it("As a product, denied and submit permissions stay out of iframe policy", async () => {
    // Given
    await setPermissionStatus("myapp", "Camera", "denied");
    await setPermissionStatus("myapp", "ChainSubmit", "granted");

    // When
    const allow = await buildAllowAttribute("myapp");

    // Then
    expect(allow).toBe("clipboard-write");
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
