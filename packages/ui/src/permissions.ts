// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Permission storage
//
// Persists host-level permission decisions per product in localStorage.
// Device permissions that map to a Permissions Policy directive also
// gate the iframe `allow` attribute (granting or revoking reloads the
// iframe). Variants without a directive are policy-only.
//
// Permission status: 'ask' (default), 'granted', or 'denied'.

import type { HostDevicePermissionRequest } from "@parity/truapi";

export type DevicePermissionName = HostDevicePermissionRequest;

export type PermissionName =
  | DevicePermissionName
  | "ChainSubmit"
  | "PreimageSubmit"
  | "StatementSubmit";

/** Device permissions the host can't actually gate (see AUTO_GRANT_DEVICE_PERMISSIONS). */
export type AutoGrantDevicePermission = "OpenUrl";

/** Device permissions that DO have a host-side enforcement point. */
export type EnforceableDevicePermission = Exclude<
  DevicePermissionName,
  AutoGrantDevicePermission
>;

/** Permissions the host actually surfaces to the user (popover + modal). */
export type EnforceablePermissionName = Exclude<
  PermissionName,
  AutoGrantDevicePermission
>;

export type PermissionStatus = "ask" | "granted" | "denied";

/**
 * Map from Host API device permission names to Permissions Policy directives.
 *
 * Only variants with a browser-level enforcement point are listed. Granting
 * a variant absent from this map is still recorded in localStorage but
 * does not alter the iframe `allow` attribute.
 */
export const DEVICE_PERMISSION_POLICY: Partial<
  Record<DevicePermissionName, string>
> = {
  Camera: "camera",
  Microphone: "microphone",
  Location: "geolocation",
  Bluetooth: "bluetooth",
  // Clipboard write is always granted by dot.li (see buildAllowAttribute).
  // The read directive requires explicit consent.
  Clipboard: "clipboard-read",
  // WebAuthn directive covering the Biometrics variant for hosts that expose
  // it via passkeys or platform authenticators.
  Biometrics: "publickey-credentials-get",
  // Chromium-only. Harmless to include on browsers that ignore it.
  NFC: "nfc",
  // Notifications has no Permissions Policy directive but IS host-gated
  // separately in handleDevicePermission (tri-state, no iframe reload).
  // OpenUrl: cross-origin navigation happens via anchor / window.open.
};

/**
 * Device permissions whose enforcement is outside the host's reach.
 *
 * Currently only OpenUrl. Cross-origin navigation happens via anchor or
 * window.open and has no host-side enforcement point. Requests for it
 * always resolve `true` and it is hidden from the settings popover.
 * Offering a control that can't actually block would mislead users.
 */
export const AUTO_GRANT_DEVICE_PERMISSIONS: ReadonlySet<AutoGrantDevicePermission> =
  new Set<AutoGrantDevicePermission>(["OpenUrl"]);

/** Type guard: narrows `DevicePermissionName` past the auto-grant set. */
export function isEnforceableDevicePermission(
  name: DevicePermissionName,
): name is EnforceableDevicePermission {
  return !(AUTO_GRANT_DEVICE_PERMISSIONS as ReadonlySet<string>).has(name);
}

/** All permissions shown in the topbar menu, in display order. */
export const ALL_PERMISSIONS: readonly {
  name: EnforceablePermissionName;
  label: string;
}[] = [
  { name: "Notifications", label: "Notifications" },
  { name: "Camera", label: "Camera" },
  { name: "Microphone", label: "Microphone" },
  { name: "Location", label: "Location" },
  { name: "Bluetooth", label: "Bluetooth" },
  { name: "NFC", label: "NFC" },
  { name: "Clipboard", label: "Clipboard" },
  { name: "Biometrics", label: "Biometrics" },
  { name: "ChainSubmit", label: "Sign Transactions" },
  { name: "PreimageSubmit", label: "Submit Preimages" },
  { name: "StatementSubmit", label: "Submit Statements" },
];

/** Returns true if the permission name maps to an iframe `allow` directive. */
export function isDevicePermission(name: string): boolean {
  return name in DEVICE_PERMISSION_POLICY;
}

const STORAGE_PREFIX = "dotli:permissions:";

type StoredPermissions = Record<string, PermissionStatus>;

function storageKey(label: string): string {
  return STORAGE_PREFIX + label;
}

function readStored(label: string): StoredPermissions {
  try {
    const raw = localStorage.getItem(storageKey(label));
    if (raw === null) {
      return {};
    }
    return JSON.parse(raw) as StoredPermissions;
  } catch {
    return {};
  }
}

function writeStored(label: string, data: StoredPermissions): void {
  localStorage.setItem(storageKey(label), JSON.stringify(data));
}

export function getPermissionStatus(
  label: string,
  permission: PermissionName,
): PermissionStatus {
  return readStored(label)[permission] ?? "ask";
}

export function setPermissionStatus(
  label: string,
  permission: PermissionName,
  status: PermissionStatus,
): void {
  const data = readStored(label);
  data[permission] = status;
  writeStored(label, data);
}

export function resetPermission(
  label: string,
  permission: PermissionName,
): void {
  const data = readStored(label);
  const { [permission]: _, ...rest } = data;
  writeStored(label, rest);
}

/** Returns the list of device permission names that have been granted. */
export function getGrantedDevicePermissions(
  label: string,
): DevicePermissionName[] {
  const data = readStored(label);
  return Object.entries(data)
    .filter(
      ([name, status]) => status === "granted" && isDevicePermission(name),
    )
    .map(([name]) => name as DevicePermissionName);
}

/** Returns true if any permission (device or remote) is granted. */
export function hasAnyGrant(label: string): boolean {
  const data = readStored(label);
  return Object.values(data).some((status) => status === "granted");
}

/**
 * Build the iframe `allow` attribute value from granted device permissions.
 * Always includes `clipboard-write`; adds Permissions Policy directives
 * for each granted device permission.
 */
export function buildAllowAttribute(label: string): string {
  const policies = ["clipboard-write"];
  for (const name of getGrantedDevicePermissions(label)) {
    const directive = DEVICE_PERMISSION_POLICY[name];
    if (directive !== undefined) {
      policies.push(directive);
    }
  }
  return policies.join("; ");
}
