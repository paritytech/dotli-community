// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductContext } from "@parity/truapi-host";
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

const PRODUCT: ProductContext = {
  productId: "myapp.paseo",
  executionKind: "App",
};

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

    const response = createPromptPermission("myapp").devicePermission(
      PRODUCT,
      permission,
    );
    await clickPromptButton(permission === "Camera" ? "Allow" : "Always allow");
    await expect(response).resolves.toEqual("AllowAlways");
    await new Promise((resolve) => setTimeout(resolve, 0));

    window.removeEventListener("dotli:device-permission-changed", onReload);
    document.body.replaceChildren();
    return reloads;
  }

  it("As a product, an auto-granted OpenUrl is answered once without a prompt", async () => {
    await expect(
      createPromptPermission("myapp").devicePermission(PRODUCT, "OpenUrl"),
    ).resolves.toBe("AllowOnce");
    expect(document.querySelector(".signing-modal-backdrop")).toBeNull();
  });

  it("As a product, my iframe stays alive when notifications are granted", async () => {
    expect(await grantAndCountReloads("Notifications")).toBe(0);
  });

  it("As a product, my iframe reloads when a grant changes its allow attribute", async () => {
    expect(await grantAndCountReloads("Camera")).toBe(1);
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

describe("three-way permission prompts", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("As a dotli user, allowing a transaction once grants only this one", async () => {
    // Given
    const response = createPromptPermission("myapp").remotePermission(PRODUCT, {
      permission: { tag: "ChainSubmit" },
    });

    // When
    await clickPromptButton("Allow once");

    // Then
    await expect(response).resolves.toBe("AllowOnce");
    expect(await getPermissionStatus("myapp", "ChainSubmit")).toBe("ask");
  });

  it("As a dotli user, always allowing transactions saves the grant", async () => {
    // Given
    const response = createPromptPermission("myapp").remotePermission(PRODUCT, {
      permission: { tag: "ChainSubmit" },
    });

    // When
    await clickPromptButton("Always allow");

    // Then
    await expect(response).resolves.toBe("AllowAlways");
    expect(await getPermissionStatus("myapp", "ChainSubmit")).toBe("granted");
  });

  it("As a dotli user, denying transactions saves the refusal", async () => {
    // Given
    const response = createPromptPermission("myapp").remotePermission(PRODUCT, {
      permission: { tag: "ChainSubmit" },
    });

    // When
    await clickPromptButton("Deny");

    // Then
    await expect(response).resolves.toBe("Deny");
    expect(await getPermissionStatus("myapp", "ChainSubmit")).toBe("denied");
  });

  it("As a dotli user, I can allow a single notification", async () => {
    // Given
    const response = createPromptPermission("myapp").devicePermission(
      PRODUCT,
      "Notifications",
    );

    // When
    await clickPromptButton("Allow once");

    // Then
    await expect(response).resolves.toBe("AllowOnce");
    expect(await getPermissionStatus("myapp", "Notifications")).toBe("ask");
  });

  it("As a dotli user, a camera prompt offers no one-time grant because granting reloads the app", async () => {
    // When
    const response = createPromptPermission("myapp").devicePermission(
      PRODUCT,
      "Camera",
    );
    await vi.waitFor(() => {
      expect(document.querySelector(".signing-modal-footer")).not.toBeNull();
    });

    // Then
    expect(promptButtonTexts()).toEqual(["Deny", "Allow"]);
    await clickPromptButton("Deny");
    await expect(response).resolves.toBe("Deny");
  });

  it("As a product, an existing grant is answered without being upgraded to a lasting one", async () => {
    // Given: the status can reflect a pending one-time grant, so answering
    // AllowAlways here would quietly make it permanent.
    await setPermissionStatus("myapp", "ChainSubmit", "granted");

    // When
    const response = createPromptPermission("myapp").remotePermission(PRODUCT, {
      permission: { tag: "ChainSubmit" },
    });

    // Then
    await expect(response).resolves.toBe("AllowOnce");
    expect(document.querySelector(".signing-modal-backdrop")).toBeNull();
  });

  it("As a dotli user, a stored notification denial is answered without a prompt", async () => {
    // Given
    await setPermissionStatus("myapp", "Notifications", "denied");

    // When
    const response = createPromptPermission("myapp").devicePermission(
      PRODUCT,
      "Notifications",
    );

    // Then
    await expect(response).resolves.toBe("Deny");
    expect(document.querySelector(".signing-modal-backdrop")).toBeNull();
    expect(document.body.textContent).toContain(
      "Notifications access is blocked. Use the permissions menu in the top bar to change this.",
    );
  });

  it("As a dotli user, dismissing a notification prompt records no decision", async () => {
    // Given
    const response = createPromptPermission("myapp").devicePermission(
      PRODUCT,
      "Notifications",
    );
    await vi.waitFor(() => {
      expect(document.querySelector(".signing-modal-backdrop")).not.toBeNull();
    });

    // When
    document.querySelector<HTMLDivElement>(".signing-modal-backdrop")?.click();

    // Then
    await expect(response).rejects.toThrow("User dismissed permission dialog");
    expect(await getPermissionStatus("myapp", "Notifications")).toBe("ask");
  });
});

function promptButtonTexts(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      ".signing-modal-footer button",
    ),
    (button) => button.textContent ?? "",
  );
}

async function clickPromptButton(text: string): Promise<void> {
  await vi.waitFor(() => {
    expect(promptButtonTexts()).toContain(text);
  });
  Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      ".signing-modal-footer button",
    ),
  )
    .find((button) => button.textContent === text)
    ?.click();
}
